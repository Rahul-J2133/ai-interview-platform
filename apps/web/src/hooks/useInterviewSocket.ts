"use client";

/**
 * useInterviewSocket — SSE-based replacement for the old WebSocket hook.
 *
 * The hardened API (src-hardened) dropped the WebSocket transport in
 * favour of Server-Sent Events with a nonce-based auth flow:
 *
 *   1. POST /api/v1/sessions/:id/stream-token  (JWT in Authorization header)
 *      → { data: { nonce, expiresIn } }
 *
 *   2. GET  /api/v1/sessions/:id/stream?nonce=<nonce>
 *      Opens the SSE stream. The JWT never appears in a URL.
 *
 *   3. POST /api/v1/sessions/:id/message       (JWT in Authorization header)
 *      Body: { content: string }
 *      Sends a candidate message.
 *
 *   4. POST /api/v1/sessions/:id/silence       (JWT in Authorization header)
 *      Sends a silence event (no body needed).
 *
 * The public interface of this hook is intentionally identical to the
 * old WebSocket version so callers (InterviewRoom, etc.) need no changes.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { useToken } from "./useToken";
import {
  getStreamToken,
  getStreamUrl,
  sendCandidateMessage,
  sendSilenceEvent,
} from "../lib/api";

const MAX_RECONNECTS = 5;

export interface SocketState {
  connected: boolean;
  connecting: boolean;
  error: string | null;
}

export interface UseInterviewSocketOptions {
  sessionId: string;
  onInterviewerMessage: (content: string, isNudge: boolean) => void;
  onStateUpdate: (phase: number, stateName: string, isComplete: boolean) => void;
  onComplete: () => void;
}

export function useInterviewSocket(opts: UseInterviewSocketOptions) {
  const getToken   = useToken();
  const esRef      = useRef<EventSource | null>(null);
  const reconnects = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>();
  // Keep the latest token cached so send/sendSilence can use it without
  // re-fetching on every keystroke.
  const tokenRef   = useRef<string>("");

  const [state, setState] = useState<SocketState>({
    connected: false, connecting: true, error: null,
  });

  const connect = useCallback(async () => {
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const token = await getToken();
      tokenRef.current = token;

      // Step 1 — obtain a short-lived stream nonce
      const nonceRes = await getStreamToken(token, opts.sessionId);
      if (nonceRes.error || !nonceRes.data) {
        throw new Error(nonceRes.error?.message ?? "Failed to obtain stream token");
      }

      // Step 2 — open the SSE stream using the nonce (JWT never in URL)
      const url = getStreamUrl(opts.sessionId, nonceRes.data.nonce);
      const es  = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        reconnects.current = 0;
        setState({ connected: true, connecting: false, error: null });
      };

      // The API emits typed SSE events — each event's `data` field is a
      // JSON-encoded SseMessage: { type, sessionId, payload, timestamp }
      es.onmessage = (ev: MessageEvent<string>) => {
        let msg: { type: string; payload: unknown };
        try { msg = JSON.parse(ev.data) as typeof msg; }
        catch { return; }

        switch (msg.type) {
          case "interviewer_message": {
            const p = msg.payload as { content: string; isNudge?: boolean };
            opts.onInterviewerMessage(p.content, p.isNudge ?? false);
            break;
          }
          case "session_state_update": {
            const p = msg.payload as { phase: number; stateName: string; isComplete?: boolean };
            opts.onStateUpdate(p.phase, p.stateName, p.isComplete ?? false);
            break;
          }
          case "session_complete":
            opts.onComplete();
            break;
          case "error": {
            const p = msg.payload as { message: string };
            setState((s) => ({ ...s, error: p.message }));
            break;
          }
          // "connected" and "pong" are heartbeat/ack events — no action needed
        }
      };

      // The API also emits events with explicit `event:` field names; wire
      // them up as named listeners so they are not missed.
      for (const eventName of [
        "interviewer_message",
        "session_state_update",
        "session_complete",
        "error",
        "connected",
        "pong",
      ] as const) {
        es.addEventListener(eventName, (ev: MessageEvent<string>) => {
          // Re-use the onmessage handler — wrap in a synthetic `type` field
          let payload: unknown;
          try { payload = JSON.parse(ev.data); }
          catch { return; }
          // Forward as if it arrived via onmessage with the event name as type
          const synthetic = { type: eventName, payload };
          es.onmessage?.(
            new MessageEvent("message", { data: JSON.stringify(synthetic) })
          );
        });
      }

      es.onerror = () => {
        setState((s) => ({ ...s, connected: false, connecting: false }));
        es.close();
        if (reconnects.current < MAX_RECONNECTS) {
          const delay = Math.min(1000 * 2 ** reconnects.current, 16_000);
          reconnects.current += 1;
          retryTimer.current = setTimeout(() => { void connect(); }, delay);
        } else {
          setState((s) => ({ ...s, error: "Connection lost. Please reload." }));
        }
      };
    } catch (err) {
      setState({ connected: false, connecting: false, error: String(err) });
      // Retry on transient errors (e.g. network blip during nonce fetch)
      if (reconnects.current < MAX_RECONNECTS) {
        const delay = Math.min(1000 * 2 ** reconnects.current, 16_000);
        reconnects.current += 1;
        retryTimer.current = setTimeout(() => { void connect(); }, delay);
      }
    }
  }, [opts.sessionId, getToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void connect();
    return () => {
      clearTimeout(retryTimer.current);
      esRef.current?.close();
    };
  }, [connect]);

  // ── send / sendSilence ───────────────────────────────────
  //
  // These fire HTTP POST requests with the cached JWT. If the token has
  // expired the next getToken() call in connect() will refresh it; for
  // messages we re-fetch to be safe.

  const send = useCallback(
    async (content: string) => {
      if (!state.connected) return;
      try {
        // Refresh token in case it expired since the stream was opened
        const token = await getToken();
        tokenRef.current = token;
        await sendCandidateMessage(token, opts.sessionId, content);
      } catch {
        // Errors are surfaced through the SSE `error` event from the server;
        // a fire-and-forget failure here is non-fatal.
      }
    },
    [state.connected, opts.sessionId, getToken]
  );

  const sendSilence = useCallback(
    async () => {
      if (!state.connected) return;
      try {
        const token = await getToken();
        tokenRef.current = token;
        await sendSilenceEvent(token, opts.sessionId);
      } catch {
        // Non-fatal
      }
    },
    [state.connected, opts.sessionId, getToken]
  );

  return { state, send, sendSilence };
}
