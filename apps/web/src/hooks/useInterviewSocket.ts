"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { useToken } from "./useToken";

const WS_BASE = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4001";
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
  const getToken    = useToken();
  const wsRef       = useRef<WebSocket | null>(null);
  const reconnects  = useRef(0);
  const retryTimer  = useRef<ReturnType<typeof setTimeout>>();
  const [state, setState] = useState<SocketState>({
    connected: false, connecting: true, error: null,
  });

  const connect = useCallback(async () => {
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const token = await getToken();
      const url   = `${WS_BASE}/ws?sessionId=${opts.sessionId}&token=${encodeURIComponent(token)}`;
      const ws    = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnects.current = 0;
        setState({ connected: true, connecting: false, error: null });
      };

      ws.onmessage = (ev: MessageEvent<string>) => {
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
        }
      };

      ws.onclose = (ev) => {
        setState((s) => ({ ...s, connected: false, connecting: false }));
        if (!ev.wasClean && reconnects.current < MAX_RECONNECTS) {
          const delay = Math.min(1000 * 2 ** reconnects.current, 16_000);
          reconnects.current += 1;
          retryTimer.current = setTimeout(() => { void connect(); }, delay);
        }
      };

      ws.onerror = () => {
        setState((s) => ({ ...s, error: "Connection error" }));
      };
    } catch (err) {
      setState({ connected: false, connecting: false, error: String(err) });
    }
  }, [opts.sessionId, getToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void connect();
    return () => {
      clearTimeout(retryTimer.current);
      wsRef.current?.close(1000, "component unmount");
    };
  }, [connect]);

  const send = useCallback((content: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "candidate_message", payload: { content } }));
  }, []);

  const sendSilence = useCallback(() => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "silence_event" }));
  }, []);

  return { state, send, sendSilence };
}
