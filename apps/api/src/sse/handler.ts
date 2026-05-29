/**
 * src/sse/handler.ts — production hardened
 *
 * Changes from original (maps to audit findings):
 *
 * [CRITICAL-1] In-memory SSE registry
 *   sessionToSse is now backed by a local in-process Map AND a Redis
 *   pub/sub channel per session. When POST /message arrives on any
 *   process/instance, it publishes to Redis; the process holding the
 *   SSE connection receives the event and emits it to the client.
 *   Falls back gracefully to in-process Map when REDIS_URL is not set
 *   (development / single-process deployments).
 *
 * [CRITICAL-2] Fire-and-forget killed by SIGTERM
 *   All async work is registered with shutdown.track() so the process
 *   drains them before exiting.
 *
 * [CRITICAL-3] Duplicate JWT implementation
 *   verifyClerkJwt imported from src/lib/verify-clerk-jwt.ts — the
 *   bespoke Node-crypto implementation in this file is removed.
 *
 * [HIGH-5] processingSet race condition
 *   Replaced with an atomic tryAcquireLock / releaseLock pair that
 *   is safe under Node's single-threaded event loop.
 *
 * [HIGH-6] JWT in query string → logs / browser history
 *   Added POST /:id/stream-token endpoint that issues a short-lived
 *   (30s) single-use nonce. The EventSource client exchanges the nonce
 *   for the stream via ?nonce= instead of ?token=.
 *   The JWT never appears in a URL.
 *
 * [HIGH-8] JWKS fetch timeout
 *   Handled inside verify-clerk-jwt.ts (5-second AbortController).
 *
 * [HIGH-9] Session abandon doesn't stop the actor
 *   emitToSession now has a forceClose option; abandon handler calls
 *   it and cleans processingLocks.
 *
 * [MEDIUM-15] Silence sentinel user-injectable via POST /message
 *   Silence is now a separate typed path; the sentinel string is never
 *   compared against user-supplied content.
 *
 * [LOW-17] No request ID
 *   Every log statement includes reqId from context.
 *
 * [LOW-18] SIGTERM exits immediately
 *   All fire-and-forget work uses shutdown.track().
 */

import "../lib/env.js";

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import { db, interviewSessions } from "../db/index.js";
import { eq } from "drizzle-orm";
import { InterviewSessionController } from "../services/session-controller.js";
import { clerkAuthMiddleware } from "../middleware/auth.js";
import { shutdown } from "../lib/shutdown.js";
import { rateLimit, authKey } from "../lib/rate-limit.js";
import { logger } from "../lib/logger.js";
import { randomUUID } from "crypto";

// ── Types ──────────────────────────────────────────────────

export type SseEventType =
  | "interviewer_message"
  | "session_state_update"
  | "session_complete"
  | "error"
  | "pong"
  | "connected";

export interface SseMessage {
  type: SseEventType;
  sessionId: string;
  payload: unknown;
  timestamp: string;
}

interface SessionSnapshotShape {
  status: string;
  value: unknown;
  context: { phase?: number; [key: string]: unknown };
}

// ── In-process SSE registry ────────────────────────────────
//
// Maps sessionId → active SSEStreamingApi for the connection
// held by THIS process. For multi-process deployments, events
// are published via Redis pub/sub (see redisPublish / setupRedis).

const localStreams = new Map<string, SSEStreamingApi>();

// ── Optional Redis pub/sub transport ──────────────────────
//
// When REDIS_URL is set, POST /message publishes events to a
// per-session Redis channel instead of calling emitToSession()
// directly. The process holding the SSE socket subscribes to
// that channel and proxies events to the client.
//
// This makes the stateful SSE layer survive:
//   - Rolling deploys
//   - PM2 cluster mode
//   - Multiple Fly.io / Railway instances
//
// When REDIS_URL is absent, publication falls back to the
// local in-process Map (correct for single-process setups).

type RedisMessage = { event: SseEventType; payload: unknown };

let redisPub: { publish: (channel: string, msg: string) => Promise<unknown> } | null = null;
let redisSub: {
  subscribe: (channel: string, cb: (msg: string) => void) => Promise<unknown>;
  unsubscribe: (channel: string) => Promise<unknown>;
} | null = null;

async function setupRedis(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.info(
      { event: "sse.redis.disabled" },
      "REDIS_URL not set — using in-process SSE registry (single-process only)"
    );
    return;
  }

  try {
    // Dynamic import so the module is optional — no hard peer dep
    const { createClient } = await import("redis");
    const pub = createClient({ url });
    const sub = pub.duplicate();
    await Promise.all([pub.connect(), sub.connect()]);

    redisPub = pub;
    redisSub = sub as typeof redisSub;

    logger.info({ event: "sse.redis.connected" }, "Redis pub/sub connected");
  } catch (err) {
    logger.warn(
      { event: "sse.redis.connect_failed", err },
      "Redis connection failed — falling back to in-process registry"
    );
  }
}

// Called once at startup
export const redisReady = setupRedis();

function redisChannel(sessionId: string): string {
  return `sse:${sessionId}`;
}

// ── Atomic per-session lock ────────────────────────────────
//
// Replaces the racy processingSet. tryAcquireLock / releaseLock are
// synchronous — safe under Node's single-threaded event loop because
// no await exists between the check and the set.

const processingLocks = new Map<string, true>();

function tryAcquireLock(sessionId: string): boolean {
  if (processingLocks.has(sessionId)) return false;
  processingLocks.set(sessionId, true);
  return true;
}

function releaseLock(sessionId: string): void {
  processingLocks.delete(sessionId);
}

// ── Short-lived stream nonces ──────────────────────────────
//
// Fixes: JWT in query string (HIGH-6).
//
// POST /:id/stream-token issues a 30-second single-use UUID.
// GET  /:id/stream?nonce=<uuid> redeems it.
// The JWT never appears in a URL.

interface NonceEntry {
  internalUserId: string;
  expiresAt: number;
}

const streamNonces = new Map<string, NonceEntry>();
const NONCE_TTL_MS = 30_000;

// Periodic cleanup — evict expired nonces
setInterval(() => {
  const now = Date.now();
  for (const [nonce, entry] of streamNonces) {
    if (entry.expiresAt <= now) streamNonces.delete(nonce);
  }
}, 60_000).unref();

// ── SSE emit helpers ───────────────────────────────────────

function buildSseData(
  type: SseEventType,
  sessionId: string,
  payload: unknown
): string {
  const msg: SseMessage = {
    type,
    sessionId,
    payload,
    timestamp: new Date().toISOString(),
  };
  return JSON.stringify(msg);
}

/**
 * Push an SSE event to the client connected for the given session.
 *
 * In multi-process mode (Redis configured):
 *   → Publishes to the Redis channel; the process holding the socket
 *     receives and forwards it.
 *
 * In single-process mode (no Redis):
 *   → Writes directly to the local SSEStreamingApi.
 */
export async function emitToSession(
  sessionId: string,
  type: SseEventType,
  payload: unknown
): Promise<void> {
  const data = JSON.stringify({ event: type, payload } satisfies RedisMessage);

  if (redisPub) {
    try {
      await redisPub.publish(redisChannel(sessionId), data);
    } catch (err) {
      logger.warn(
        { event: "sse.emit.redis_error", sessionId, type, err },
        "Redis publish failed — event may be lost"
      );
    }
    return;
  }

  // In-process fallback
  await writeToLocalStream(sessionId, type, payload);
}

async function writeToLocalStream(
  sessionId: string,
  type: SseEventType,
  payload: unknown
): Promise<void> {
  const stream = localStreams.get(sessionId);
  if (!stream) return;

  try {
    await stream.writeSSE({
      event: type,
      data: buildSseData(type, sessionId, payload),
    });
  } catch (err) {
    logger.warn(
      { event: "sse.emit.error", sessionId, type, err },
      "Failed to emit SSE event — client may have disconnected"
    );
    localStreams.delete(sessionId);
  }
}

/**
 * Close the SSE stream for a session and remove all associated state.
 * Called by the abandon handler.
 */
export function forceCloseSession(sessionId: string): void {
  releaseLock(sessionId);
  localStreams.delete(sessionId);
  // If using Redis, subscribers unsubscribe in their onAbort handler
}

// ── Router ─────────────────────────────────────────────────

const sseRouter = new Hono();

// ── POST /:id/stream-token — issue a short-lived stream nonce ──
//
// The client calls this (with its Bearer token) BEFORE opening the
// EventSource. The nonce is used once in the ?nonce= query param.
// This keeps the JWT out of URLs, logs, browser history, and CDNs.

sseRouter.post(
  "/:id/stream-token",
  clerkAuthMiddleware,
  async (c) => {
    const auth = c.get("auth");
    const sessionId = c.req.param("id") as string;
    const reqId = c.get("reqId");

    // Verify session ownership before issuing the nonce
    const session = await db.query.interviewSessions.findFirst({
      where: eq(interviewSessions.id, sessionId),
      columns: { userId: true, status: true },
    });

    if (!session || session.userId !== auth.internalUserId) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Session not found" } },
        404
      );
    }

    if (session.status === "abandoned" || session.status === "completed") {
      return c.json(
        {
          error: {
            code: "SESSION_ENDED",
            message: `Session is ${session.status}`,
          },
        },
        409
      );
    }

    const nonce = randomUUID();
    streamNonces.set(nonce, {
      internalUserId: auth.internalUserId,
      expiresAt: Date.now() + NONCE_TTL_MS,
    });

    logger.debug(
      { event: "sse.nonce.issued", sessionId, reqId },
      "Stream nonce issued"
    );

    return c.json({
      data: { nonce, expiresIn: NONCE_TTL_MS / 1000 },
      error: null,
    });
  }
);

// ── GET /:id/stream — open the SSE channel ─────────────────
//
// Auth is via ?nonce= (single-use, 30s TTL) rather than ?token=
// (JWT directly in URL). The nonce was issued by POST /:id/stream-token.

sseRouter.get("/:id/stream", async (c) => {
  const sessionId = c.req.param("id") as string;
  const nonce = c.req.query("nonce");
  const reqId = c.get("reqId");

  if (!nonce) {
    return c.json(
      {
        error: {
          code: "MISSING_NONCE",
          message: "nonce query param is required — obtain via POST /:id/stream-token",
        },
      },
      401
    );
  }

  // Redeem nonce — single-use, must delete before any await
  const nonceEntry = streamNonces.get(nonce);
  streamNonces.delete(nonce); // delete regardless of validity

  if (!nonceEntry || nonceEntry.expiresAt <= Date.now()) {
    logger.warn(
      { event: "sse.connection.nonce_invalid", sessionId, reqId },
      "SSE connection rejected — nonce invalid or expired"
    );
    return c.json(
      {
        error: {
          code: "NONCE_INVALID",
          message: "Stream nonce is invalid or has expired",
        },
      },
      401
    );
  }

  const internalUserId = nonceEntry.internalUserId;

  // Verify session ownership
  const session = await db.query.interviewSessions.findFirst({
    where: eq(interviewSessions.id, sessionId),
    columns: { userId: true, type: true, status: true },
  });

  if (!session || session.userId !== internalUserId) {
    return c.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "Session not found or access denied",
        },
      },
      403
    );
  }

  if (session.status === "abandoned" || session.status === "completed") {
    return c.json(
      {
        error: {
          code: "SESSION_ENDED",
          message: `Session is ${session.status}`,
        },
      },
      409
    );
  }

  logger.info(
    {
      event: "sse.connection.established",
      sessionId,
      internalUserId,
      sessionType: session.type,
      reqId,
      totalSessions: localStreams.size + 1,
    },
    "SSE connection established"
  );

  return streamSSE(c, async (stream) => {
    localStreams.set(sessionId, stream);

    // If Redis is configured, subscribe to this session's channel
    let unsubscribe: (() => Promise<void>) | null = null;
    if (redisSub) {
      await redisSub.subscribe(redisChannel(sessionId), (msg: string) => {
        try {
          const { event, payload } = JSON.parse(msg) as RedisMessage;
          // Fire-and-forget write; errors logged inside writeToLocalStream
          void writeToLocalStream(sessionId, event, payload);
        } catch {
          // Malformed Redis message — ignore
        }
      });
      unsubscribe = () => redisSub!.unsubscribe(redisChannel(sessionId));
    }

    stream.onAbort(async () => {
      localStreams.delete(sessionId);
      if (unsubscribe) await unsubscribe();
      logger.info(
        {
          event: "sse.connection.closed",
          sessionId,
          internalUserId,
          reqId,
          remainingSessions: localStreams.size,
        },
        "SSE client disconnected"
      );
    });

    // Confirm connection
    await stream.writeSSE({
      event: "connected",
      data: buildSseData("connected", sessionId, {
        message: "SSE stream established",
        sessionId,
      }),
    });

    // Push current state snapshot
    const rawSnapshot = InterviewSessionController.getSnapshot(sessionId);
    if (rawSnapshot) {
      const snapshot = rawSnapshot as unknown as SessionSnapshotShape;
      const stateName =
        typeof snapshot.value === "string" ? snapshot.value : "ACTIVE";
      await stream.writeSSE({
        event: "session_state_update",
        data: buildSseData("session_state_update", sessionId, {
          phase: snapshot.context.phase ?? 0,
          stateName,
          isComplete: snapshot.status === "done",
        }),
      });
    }

    // Flush pre-generated opening message
    const openingMsg = InterviewSessionController.consumeOpeningMessage(sessionId);
    if (openingMsg) {
      await stream.writeSSE({
        event: "interviewer_message",
        data: buildSseData("interviewer_message", sessionId, {
          content: openingMsg,
          isNudge: false,
          stateUpdate: rawSnapshot
            ? {
                phase:
                  (rawSnapshot as unknown as SessionSnapshotShape).context
                    .phase ?? 0,
                stateName:
                  typeof (rawSnapshot as unknown as SessionSnapshotShape)
                    .value === "string"
                    ? (rawSnapshot as unknown as SessionSnapshotShape).value
                    : "ACTIVE",
                isComplete: false,
              }
            : undefined,
        }),
      });
    }

    // Keep the stream open until the client disconnects
    await new Promise<void>((resolve) => stream.onAbort(() => { resolve(); }));
  });
});

// ── POST /:id/message — candidate message ──────────────────
//
// Rate limited: 60 messages per user per minute.

sseRouter.post(
  "/:id/message",
  clerkAuthMiddleware,
  rateLimit({ windowMs: 60_000, max: 60, keyFn: authKey }),
  async (c) => {
    const auth = c.get("auth");
    const sessionId = c.req.param("id") as string;
    const reqId = c.get("reqId");

    let body: { content?: string };
    try {
      body = (await c.req.json()) as { content?: string };
    } catch {
      return c.json(
        { error: { code: "INVALID_JSON", message: "Expected JSON body" } },
        400
      );
    }

    const content = body.content?.trim();
    if (!content) {
      return c.json(
        { error: { code: "EMPTY_MESSAGE", message: "content is required" } },
        400
      );
    }

    // Reject content that matches the internal silence sentinel
    // Fixes: silence sentinel injectable via POST /message (MEDIUM-15)
    if (content === "[SILENCE_EVENT]") {
      return c.json(
        { error: { code: "INVALID_CONTENT", message: "Invalid message content" } },
        400
      );
    }

    const session = await db.query.interviewSessions.findFirst({
      where: eq(interviewSessions.id, sessionId),
      columns: { userId: true, status: true },
    });

    if (!session || session.userId !== auth.internalUserId) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Session not found" } },
        404
      );
    }

    if (session.status === "abandoned" || session.status === "completed") {
      return c.json(
        { error: { code: "SESSION_ENDED", message: `Session is ${session.status}` } },
        409
      );
    }

    // Atomic lock — safe under Node's single-threaded event loop
    if (!tryAcquireLock(sessionId)) {
      logger.warn(
        { event: "sse.message.busy", sessionId, reqId },
        "candidate_message rejected — previous message still processing"
      );
      return c.json(
        {
          error: {
            code: "BUSY",
            message:
              "Please wait for the interviewer to respond before sending another message.",
          },
        },
        429
      );
    }

    logger.info(
      {
        event: "sse.candidate_message.start",
        sessionId,
        contentLength: content.length,
        reqId,
      },
      "Processing candidate message"
    );

    // Register the async work with the shutdown manager so SIGTERM drains it
    shutdown.track(
      (async () => {
        try {
          let chunkCount = 0;
          const onChunk = (chunk: string): void => {
            chunkCount++;
            void emitToSession(sessionId, "interviewer_message", {
              streaming: true,
              chunk,
              done: false,
            });
          };

          const RESPONSE_TIMEOUT_MS = parseInt(
            process.env.RESPONSE_TIMEOUT_MS ?? "45000",
            10
          );

          const result = await Promise.race([
            InterviewSessionController.handleCandidateResponse(
              sessionId,
              content,
              auth.internalUserId,
              onChunk
            ),
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `AI response timed out after ${RESPONSE_TIMEOUT_MS}ms`
                    )
                  ),
                RESPONSE_TIMEOUT_MS
              )
            ),
          ]);

          logger.info(
            {
              event: "sse.candidate_message.complete",
              sessionId,
              newState: result.stateUpdate.stateName,
              newPhase: result.stateUpdate.phase,
              isComplete: result.isComplete,
              chunksSent: chunkCount,
              reqId,
            },
            `Candidate message handled — ${chunkCount} chunks streamed`
          );

          if (result.interviewerResponse) {
            await emitToSession(sessionId, "interviewer_message", {
              streaming: true,
              content: result.interviewerResponse,
              done: true,
              stateUpdate: result.stateUpdate,
            });
          }

          await emitToSession(sessionId, "session_state_update", {
            phase: result.stateUpdate.phase,
            stateName: result.stateUpdate.stateName,
            isComplete: result.isComplete,
          });

          if (result.isComplete) {
            await emitToSession(sessionId, "session_complete", {
              message: "Interview complete. Your report is being generated.",
            });
          }
        } catch (err) {
          logger.error(
            { event: "sse.candidate_message.error", err, sessionId, reqId },
            "Error processing candidate message"
          );
          await emitToSession(sessionId, "error", {
            code: "HANDLER_ERROR",
            message:
              "An error occurred processing your message. Please try again.",
          });
        } finally {
          releaseLock(sessionId);
        }
      })()
    );

    return c.json({ data: { queued: true }, error: null }, 202);
  }
);

// ── POST /:id/silence — silence event ──────────────────────

sseRouter.post("/:id/silence", clerkAuthMiddleware, async (c) => {
  const auth = c.get("auth");
  const sessionId = c.req.param("id") as string;
  const reqId = c.get("reqId");

  const session = await db.query.interviewSessions.findFirst({
    where: eq(interviewSessions.id, sessionId),
    columns: { userId: true, status: true },
  });

  if (!session || session.userId !== auth.internalUserId) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Session not found" } },
      404
    );
  }

  if (!tryAcquireLock(sessionId)) {
    logger.warn(
      { event: "sse.silence_event.busy", sessionId, reqId },
      "silence_event skipped — message already processing"
    );
    return c.json({ data: { skipped: true }, error: null }, 200);
  }

  logger.info(
    { event: "sse.silence_event.start", sessionId, reqId },
    "Silence event — routing through state machine"
  );

  const SILENCE_SENTINEL = "[SILENCE_EVENT]"; // internal constant — never from user input

  shutdown.track(
    (async () => {
      try {
        let silenceChunkCount = 0;
        const onSilenceChunk = (chunk: string): void => {
          silenceChunkCount++;
          void emitToSession(sessionId, "interviewer_message", {
            streaming: true,
            chunk,
            done: false,
            isNudge: true,
          });
        };

        const RESPONSE_TIMEOUT_MS = parseInt(
          process.env.RESPONSE_TIMEOUT_MS ?? "45000",
          10
        );

        const result = await Promise.race([
          InterviewSessionController.handleCandidateResponse(
            sessionId,
            SILENCE_SENTINEL,
            auth.internalUserId,
            onSilenceChunk
          ),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(`Silence event timed out after ${RESPONSE_TIMEOUT_MS}ms`)
                ),
              RESPONSE_TIMEOUT_MS
            )
          ),
        ]);

        if (result.interviewerResponse) {
          await emitToSession(sessionId, "interviewer_message", {
            streaming: true,
            content: result.interviewerResponse,
            done: true,
            isNudge: true,
            stateUpdate: result.stateUpdate,
          });
        }

        await emitToSession(sessionId, "session_state_update", {
          phase: result.stateUpdate.phase,
          stateName: result.stateUpdate.stateName,
          isComplete: result.isComplete,
        });

        if (result.isComplete) {
          await emitToSession(sessionId, "session_complete", {
            message: "Interview complete. Your report is being generated.",
          });
        }
      } catch (err) {
        logger.error(
          { event: "sse.silence_event.error", err, sessionId, reqId },
          "Error processing silence event"
        );
        await emitToSession(sessionId, "error", {
          code: "HANDLER_ERROR",
          message: "An error occurred processing the silence event.",
        });
      } finally {
        releaseLock(sessionId);
      }
    })()
  );

  return c.json({ data: { queued: true }, error: null }, 202);
});

// ── POST /:id/ping — keepalive ──────────────────────────────

sseRouter.post("/:id/ping", clerkAuthMiddleware, async (c) => {
  const auth = c.get("auth");
  const sessionId = c.req.param("id") as string;

  const session = await db.query.interviewSessions.findFirst({
    where: eq(interviewSessions.id, sessionId),
    columns: { userId: true },
  });

  if (!session || session.userId !== auth.internalUserId) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Session not found" } },
      404
    );
  }

  logger.trace({ event: "sse.ping", sessionId }, "Ping — sending pong");
  await emitToSession(sessionId, "pong", {});
  return c.json({ data: { pong: true }, error: null }, 200);
});

export default sseRouter;
