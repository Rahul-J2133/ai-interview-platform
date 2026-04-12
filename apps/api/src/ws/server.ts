/**
 * WebSocket server for real-time interview communication.
 *
 * Each active interview session gets one persistent WS connection.
 * The server bridges candidate messages → session controller → AI responses.
 *
 * Fixes applied vs original
 * ─────────────────────────
 * 1. Streaming — interviewer response is streamed token-by-token using the
 *    existing "interviewer_message" WsMessageType with a payload shape of
 *    { streaming: true, chunk: string, done: false } for mid-stream frames
 *    and { streaming: true, content: string, done: true, stateUpdate } for
 *    the terminal frame. No new WsMessageType values are introduced.
 *
 * 2. Error logging — Error objects passed directly to logger (not String(err))
 *    so Pino serializes the full stack trace and structured fields.
 *
 * 3. JWT verification — The RS256 signature is now verified against Clerk's
 *    JWKS endpoint using Node's built-in `crypto` module. No third-party JWT
 *    library is required. The previous implementation only decoded the base64
 *    payload and checked `exp`, which is not authentication.
 *
 * 4. silence_event — routed through handleCandidateResponse with a sentinel
 *    content string so the state machine, silenceEvents counter, transcript,
 *    and DB row all stay in sync. The previous implementation sent a hardcoded
 *    string directly, bypassing the actor entirely.
 *
 * 5. Async rejection safety — the connection handler is now a single async
 *    IIFE so all rejections (auth, DB query, snapshot send) are caught by one
 *    handler instead of the previous .then(async …).catch(…) pattern that
 *    silently swallowed any rejection thrown inside the async .then body.
 */

import "../lib/env"; // ← loads dotenv before db is touched

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import * as crypto from "crypto";
import * as https from "https";
import { db, interviewSessions, users } from "@interview/db";
import { eq } from "drizzle-orm";
import type { WsMessage, WsMessageType } from "@interview/shared-types";
import { InterviewSessionController } from "../services/session-controller";
import { logger } from "../lib/logger";

// ============================================================
// TYPES
// ============================================================

interface AuthenticatedWs extends WebSocket {
  sessionId: string;
  internalUserId: string;
  isAlive: boolean;
}

/** Minimal shape we care about from an XState snapshot */
interface SessionSnapshotShape {
  status: string;
  value: unknown;
  context: {
    phase?: number;
    [key: string]: unknown;
  };
}

/** Shape of a Clerk JWKS response */
interface JwksKey {
  kty: string;
  kid: string;
  use: string;
  alg: string;
  n: string;
  e: string;
}

interface JwksResponse {
  keys: JwksKey[];
}

// ============================================================
// REGISTRY
// ============================================================

const sessionToWs = new Map<string, AuthenticatedWs>();

// ============================================================
// HELPERS
// ============================================================

function sendWs(ws: WebSocket, type: WsMessageType, sessionId: string, payload: unknown): void {
  const msg: WsMessage = {
    type,
    sessionId,
    payload,
    timestamp: new Date().toISOString(),
  };
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function emitToSession(sessionId: string, type: WsMessageType, payload: unknown): void {
  const ws = sessionToWs.get(sessionId);
  if (ws) sendWs(ws, type, sessionId, payload);
}

// ============================================================
// JWT VERIFICATION — Node built-in crypto, no third-party library
//
// Fix #3: The original resolveWsAuth decoded the JWT payload from base64 and
// only checked `exp`. That is not authentication — any forged token with a
// valid-looking `sub` and a future `exp` would pass.
//
// Real verification requires:
//   1. Fetch the public keys from Clerk's JWKS endpoint
//   2. Find the key whose `kid` matches the JWT header's `kid`
//   3. Verify the RS256 signature using that public key
//   4. Check `exp` (done manually after signature check)
//
// The JWKS is cached in memory after the first fetch. It is re-fetched if a
// token presents a `kid` that isn't in the cache (key rotation).
// ============================================================

let jwksCache: Map<string, crypto.KeyObject> = new Map();
let jwksCachePopulatedAt = 0;
const JWKS_TTL_MS = 10 * 60 * 1000; // re-fetch after 10 minutes

function getJwksUrl(): string {
  const explicit = process.env.CLERK_JWKS_URL;
  if (explicit) return explicit;

  const frontendApi = process.env.CLERK_DOMAIN;
  if (frontendApi) {
    return `https://${frontendApi}/.well-known/jwks.json`;
  }

  throw new Error(
    "CLERK_JWKS_URL or CLERK_FRONTEND_API_URL must be set for WS JWT verification"
  );
}

/** Fetch JWKS from Clerk and return a kid → KeyObject map. */
function fetchJwks(): Promise<Map<string, crypto.KeyObject>> {
  return new Promise((resolve, reject) => {
    const url = getJwksUrl();
    logger.debug({ event: "ws.jwks.fetch", url }, "Fetching JWKS");

    https.get(url, (res) => {
      let raw = "";
      res.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
      res.on("end", () => {
        try {
          const body = JSON.parse(raw) as JwksResponse;
          const keyMap = new Map<string, crypto.KeyObject>();
          for (const key of body.keys) {
            if (key.kty === "RSA" && key.alg === "RS256") {
              const pub = crypto.createPublicKey({ key: key as unknown as crypto.JsonWebKey, format: "jwk" });
              keyMap.set(key.kid, pub);
            }
          }
          logger.debug(
            { event: "ws.jwks.fetched", keyCount: keyMap.size },
            `JWKS fetched: ${keyMap.size} RS256 keys`
          );
          resolve(keyMap);
        } catch (err) {
          reject(new Error(`Failed to parse JWKS response: ${String(err)}`));
        }
      });
      res.on("error", (err) => reject(err));
    }).on("error", (err) => reject(err));
  });
}

/** Return the KeyObject for the given kid, fetching/refreshing the cache as needed. */
async function getPublicKey(kid: string): Promise<crypto.KeyObject> {
  const now = Date.now();

  // Use cache if fresh and kid is present
  if (jwksCache.has(kid) && now - jwksCachePopulatedAt < JWKS_TTL_MS) {
    return jwksCache.get(kid)!;
  }

  // Fetch (either first time or cache is stale / kid not found)
  jwksCache = await fetchJwks();
  jwksCachePopulatedAt = Date.now();

  const key = jwksCache.get(kid);
  if (!key) {
    throw new Error(`No JWKS key found for kid: ${kid}`);
  }
  return key;
}

/**
 * Verify a Clerk-issued JWT (RS256) using the project's JWKS endpoint.
 * Returns the verified `sub` claim on success, throws on any failure.
 */
async function verifyClerkJwt(token: string): Promise<string> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT: expected 3 parts");

  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

  // Decode header to get kid
  let header: { kid?: string; alg?: string };
  try {
    header = JSON.parse(Buffer.from(rawHeader, "base64url").toString("utf8")) as {
      kid?: string;
      alg?: string;
    };
  } catch {
    throw new Error("Failed to decode JWT header");
  }

  if (header.alg !== "RS256") {
    throw new Error(`Unexpected JWT algorithm: ${header.alg ?? "none"} (expected RS256)`);
  }
  if (!header.kid) {
    throw new Error("JWT header missing kid");
  }

  // Fetch public key for this kid
  const publicKey = await getPublicKey(header.kid);

  // Verify signature: RS256(base64url(header) + "." + base64url(payload))
  const signingInput = `${rawHeader}.${rawPayload}`;
  const signature    = Buffer.from(rawSignature, "base64url");
  const valid        = crypto.verify("sha256", Buffer.from(signingInput), publicKey, signature);

  if (!valid) {
    throw new Error("JWT signature verification failed");
  }

  // Decode and validate claims
  let payload: { sub?: string; exp?: number };
  try {
    payload = JSON.parse(Buffer.from(rawPayload, "base64url").toString("utf8")) as {
      sub?: string;
      exp?: number;
    };
  } catch {
    throw new Error("Failed to decode JWT payload");
  }

  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("JWT has expired");
  }
  if (!payload.sub) {
    throw new Error("JWT missing sub claim");
  }

  return payload.sub;
}

/**
 * Verify the WS token and resolve the caller's internal user ID.
 * Throws on any verification or lookup failure.
 */
async function resolveWsAuth(token: string): Promise<{ internalUserId: string }> {
  logger.debug({ event: "ws.auth.start" }, "Verifying WS JWT");

  let sub: string;
  try {
    sub = await verifyClerkJwt(token);
    logger.debug({ event: "ws.auth.jwt_verified", sub }, "JWT signature verified");
  } catch (err) {
    logger.warn({ event: "ws.auth.jwt_invalid", err }, "JWT verification failed");
    throw err;
  }

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkUserId, sub))
    .limit(1);

  if (!user) {
    const msg = `No internal user found for Clerk sub: ${sub}`;
    logger.warn({ event: "ws.auth.user_not_found", sub }, msg);
    throw new Error(msg);
  }

  logger.debug(
    { event: "ws.auth.resolved", sub, internalUserId: user.id },
    "WS auth resolved to internal user"
  );

  return { internalUserId: user.id };
}

// ============================================================
// SILENCE SENTINEL
//
// Fix #4: silence_event must flow through handleCandidateResponse so the
// actor receives a CANDIDATE_RESPONSE event and the silenceEvents counter,
// transcript, and DB row are all updated. The sentinel string signals to the
// AI prompt's NUDGE/SILENCE state handling to produce a nudge response.
// ============================================================

const SILENCE_SENTINEL = "[SILENCE_EVENT]";

// ============================================================
// SERVER FACTORY
// ============================================================

export function createWebSocketServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  // Heartbeat — terminate dead connections
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      const aws = ws as AuthenticatedWs;
      if (!aws.isAlive) {
        logger.debug(
          { event: "ws.heartbeat.terminate", sessionId: aws.sessionId },
          "WS dead — terminating"
        );
        aws.terminate();
        return;
      }
      aws.isAlive = false;
      aws.ping();
    });
  }, 30_000);

  wss.on("close", () => {
    clearInterval(heartbeat);
    logger.info({ event: "ws.server.close" }, "WS server closed — heartbeat cleared");
  });

  wss.on("connection", (rawWs: WebSocket, req: IncomingMessage) => {
    const aws = rawWs as AuthenticatedWs;
    aws.isAlive = true;
    aws.on("pong", () => {
      aws.isAlive = true;
      logger.trace(
        { event: "ws.pong", sessionId: aws.sessionId },
        "Pong received — connection alive"
      );
    });

    const url       = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const sessionId = url.searchParams.get("sessionId");
    const token     = url.searchParams.get("token");

    logger.info(
      {
        event:         "ws.connection.attempt",
        sessionId:     sessionId ?? "missing",
        hasToken:      !!token,
        remoteAddress: req.socket.remoteAddress,
      },
      "Incoming WS connection"
    );

    if (!sessionId || !token) {
      logger.warn(
        { event: "ws.connection.missing_params", sessionId, hasToken: !!token },
        "WS connection rejected — missing sessionId or token"
      );
      sendWs(aws, "error", sessionId ?? "unknown", {
        code:    "MISSING_PARAMS",
        message: "sessionId and token query params are required",
      });
      aws.close(1008, "Missing params");
      return;
    }

    // Fix #5: single async IIFE so every rejection — from resolveWsAuth, the
    // DB ownership query, or the snapshot push — is caught by one .catch().
    // The previous .then(async …).catch(…) only caught rejections from the
    // resolveWsAuth promise; anything thrown inside the async .then body
    // produced an unhandled rejection that silently killed connection setup.
    (async () => {
      const { internalUserId } = await resolveWsAuth(token);

      logger.debug(
        { event: "ws.connection.auth_ok", sessionId, internalUserId },
        "WS auth succeeded — verifying session ownership"
      );

      const session = await db.query.interviewSessions.findFirst({
        where:   eq(interviewSessions.id, sessionId),
        columns: { userId: true, type: true, status: true },
      });

      if (!session || session.userId !== internalUserId) {
        logger.warn(
          {
            event:         "ws.connection.unauthorized",
            sessionId,
            internalUserId,
            sessionExists: !!session,
            ownerMatch:    session?.userId === internalUserId,
          },
          "WS connection rejected — session not found or not owned by user"
        );
        sendWs(aws, "error", sessionId, {
          code:    "UNAUTHORIZED",
          message: "Session not found or access denied",
        });
        aws.close(1008, "Unauthorized");
        return;
      }

      if (session.status === "abandoned" || session.status === "completed") {
        logger.warn(
          { event: "ws.connection.session_ended", sessionId, status: session.status },
          `WS connection rejected — session is ${session.status}`
        );
        sendWs(aws, "error", sessionId, {
          code:    "SESSION_ENDED",
          message: `Session is ${session.status}`,
        });
        aws.close(1000, "Session ended");
        return;
      }

      aws.sessionId      = sessionId;
      aws.internalUserId = internalUserId;
      sessionToWs.set(sessionId, aws);

      logger.info(
        {
          event:         "ws.connection.established",
          sessionId,
          internalUserId,
          sessionType:   session.type,
          sessionStatus: session.status,
          totalSessions: sessionToWs.size,
        },
        "WS connection established"
      );

      // Push current state so the client can render immediately
      const rawSnapshot = InterviewSessionController.getSnapshot(sessionId);
      if (rawSnapshot) {
        const snapshot  = rawSnapshot as unknown as SessionSnapshotShape;
        const stateName = typeof snapshot.value === "string" ? snapshot.value : "ACTIVE";
        logger.debug(
          {
            event:     "ws.connection.initial_state",
            sessionId,
            stateName,
            phase:     snapshot.context.phase ?? 0,
          },
          "Pushing initial state snapshot to client"
        );
        sendWs(aws, "session_state_update", sessionId, {
          phase:      snapshot.context.phase ?? 0,
          stateName,
          isComplete: snapshot.status === "done",
        });
      } else {
        logger.debug(
          { event: "ws.connection.no_snapshot", sessionId },
          "No live actor snapshot available"
        );
      }

      aws.on("message", (raw) => {
        handleMessage(aws, raw).catch((err: unknown) => {
          // Fix #2: pass err directly — not String(err)
          logger.error(
            { event: "ws.message.unhandled_rejection", err, sessionId: aws.sessionId },
            "Unhandled rejection in handleMessage"
          );
          sendWs(aws, "error", aws.sessionId, {
            code:    "HANDLER_ERROR",
            message: "An internal error occurred. Please try again.",
          });
        });
      });

      aws.on("close", (code, reason) => {
        sessionToWs.delete(sessionId);
        logger.info(
          {
            event:             "ws.connection.closed",
            sessionId,
            internalUserId,
            closeCode:         code,
            closeReason:       reason.toString(),
            remainingSessions: sessionToWs.size,
          },
          `WS disconnected (code=${code})`
        );
      });

      aws.on("error", (err) => {
        // Fix #2: pass err object directly — not String(err)
        logger.error(
          { event: "ws.socket.error", err, sessionId },
          "WS socket error"
        );
      });

    })().catch((err: unknown) => {
      // Fix #5: single catch for the whole async setup IIFE
      logger.warn(
        { event: "ws.connection.setup_failed", err, sessionId },
        "WS connection setup failed"
      );
      sendWs(aws, "error", sessionId, {
        code:    "AUTH_FAILED",
        message: "Authentication failed",
      });
      aws.close(1008, "Auth failed");
    });
  });

  logger.info(
    { event: "ws.server.started", path: "/ws" },
    "WebSocket server started on path /ws"
  );

  return wss;
}

// ============================================================
// MESSAGE HANDLING
// ============================================================

interface IncomingWsMessage {
  type: string;
  payload?: unknown;
}

async function handleMessage(aws: AuthenticatedWs, raw: import("ws").RawData): Promise<void> {
  let msg: IncomingWsMessage;

  try {
    msg = JSON.parse(raw.toString()) as IncomingWsMessage;
  } catch (err) {
    // Fix #2: pass err directly — not String(err)
    logger.warn(
      { event: "ws.message.parse_error", err, sessionId: aws.sessionId },
      "Failed to parse incoming WS message"
    );
    sendWs(aws, "error", aws.sessionId, {
      code:    "INVALID_JSON",
      message: "Could not parse message",
    });
    return;
  }

  logger.debug(
    { event: "ws.message.received", sessionId: aws.sessionId, type: msg.type },
    `WS message: ${msg.type}`
  );

  try {
    switch (msg.type) {

      // ── candidate_message ────────────────────────────────────────────────────
      case "candidate_message": {
        const payload = msg.payload as { content?: string } | undefined;
        const content = payload?.content?.trim();

        if (!content) {
          logger.warn(
            { event: "ws.candidate_message.empty", sessionId: aws.sessionId },
            "candidate_message rejected — empty content"
          );
          sendWs(aws, "error", aws.sessionId, {
            code:    "EMPTY_MESSAGE",
            message: "Message content is required",
          });
          return;
        }

        logger.info(
          {
            event:         "ws.candidate_message.start",
            sessionId:     aws.sessionId,
            contentLength: content.length,
            preview:       content.slice(0, 80),
          },
          "Processing candidate message"
        );

        // Fix #1: stream the AI response token-by-token using the existing
        // "interviewer_message" WsMessageType with a payload shape of:
        //   { streaming: true, chunk: string, done: false }  — mid-stream token
        //   { streaming: true, content: string, done: true } — terminal frame
        //
        // No new WsMessageType values are introduced. The client distinguishes
        // streaming frames from the traditional single-shot message by the
        // presence of streaming: true in the payload.
        //
        // The controller still returns the full accumulated text in
        // result.interviewerResponse, so transcript persistence is unchanged.
        let chunkCount = 0;
        const onChunk = (chunk: string): void => {
          chunkCount++;
          logger.trace(
            {
              event:       "ws.interviewer.stream_chunk",
              sessionId:   aws.sessionId,
              chunkIndex:  chunkCount,
              chunkLength: chunk.length,
            },
            `Streaming chunk #${chunkCount}`
          );
          sendWs(aws, "interviewer_message", aws.sessionId, {
            streaming: true,
            chunk,
            done:      false,
          });
        };

        const result = await InterviewSessionController.handleCandidateResponse(
          aws.sessionId,
          content,
          aws.internalUserId,
          onChunk
        );

        logger.info(
          {
            event:          "ws.candidate_message.complete",
            sessionId:      aws.sessionId,
            newState:       result.stateUpdate.stateName,
            newPhase:       result.stateUpdate.phase,
            isComplete:     result.isComplete,
            chunksSent:     chunkCount,
            responseLength: result.interviewerResponse.length,
          },
          `Candidate message handled — ${chunkCount} chunks streamed`
        );

        // Terminal frame: includes the full text so clients that missed chunks
        // can reconstruct the complete message. Also sent when streaming is
        // disabled (chunkCount === 0) so the client always gets the response.
        if (result.interviewerResponse) {
          sendWs(aws, "interviewer_message", aws.sessionId, {
            streaming:   true,
            content:     result.interviewerResponse,
            done:        true,
            stateUpdate: result.stateUpdate,
          });
        }

        sendWs(aws, "session_state_update", aws.sessionId, {
          phase:      result.stateUpdate.phase,
          stateName:  result.stateUpdate.stateName,
          isComplete: result.isComplete,
        });

        if (result.isComplete) {
          logger.info(
            { event: "ws.session.complete", sessionId: aws.sessionId },
            "Session complete — notifying client"
          );
          sendWs(aws, "session_complete", aws.sessionId, {
            message: "Interview complete. Your report is being generated.",
          });
        }
        break;
      }

      // ── silence_event ────────────────────────────────────────────────────────
      //
      // Fix #4: route through handleCandidateResponse with a sentinel string.
      //
      // Original behaviour — sent a hardcoded nudge string directly over the
      // socket and returned, meaning:
      //   - The actor never received a CANDIDATE_RESPONSE event
      //   - silenceEvents counter was never incremented
      //   - No transcript row was written
      //   - The DB session row was never updated
      //   - generateInterviewerResponse was never called
      //
      // Now the sentinel flows through the normal pipeline. The machine's
      // current state (likely a NUDGE/SILENCE state) combined with the sentinel
      // content causes the AI prompt to emit the appropriate nudge response.
      // classifyMsgType() already returns "nudge" for states containing "nudge"
      // or "silence", so the transcript MessageType is also correct.
      case "silence_event": {
        logger.info(
          { event: "ws.silence_event.start", sessionId: aws.sessionId },
          "Silence event — routing through state machine"
        );

        let silenceChunkCount = 0;
        const onSilenceChunk = (chunk: string): void => {
          silenceChunkCount++;
          sendWs(aws, "interviewer_message", aws.sessionId, {
            streaming: true,
            chunk,
            done:      false,
            isNudge:   true,
          });
        };

        const result = await InterviewSessionController.handleCandidateResponse(
          aws.sessionId,
          SILENCE_SENTINEL,
          aws.internalUserId,
          onSilenceChunk
        );

        logger.info(
          {
            event:          "ws.silence_event.complete",
            sessionId:      aws.sessionId,
            newState:       result.stateUpdate.stateName,
            newPhase:       result.stateUpdate.phase,
            chunksSent:     silenceChunkCount,
            responseLength: result.interviewerResponse.length,
          },
          "Silence event handled"
        );

        if (result.interviewerResponse) {
          sendWs(aws, "interviewer_message", aws.sessionId, {
            streaming:   true,
            content:     result.interviewerResponse,
            done:        true,
            isNudge:     true,
            stateUpdate: result.stateUpdate,
          });
        }

        sendWs(aws, "session_state_update", aws.sessionId, {
          phase:      result.stateUpdate.phase,
          stateName:  result.stateUpdate.stateName,
          isComplete: result.isComplete,
        });

        if (result.isComplete) {
          sendWs(aws, "session_complete", aws.sessionId, {
            message: "Interview complete. Your report is being generated.",
          });
        }
        break;
      }

      // ── ping ─────────────────────────────────────────────────────────────────
      case "ping": {
        logger.trace(
          { event: "ws.ping", sessionId: aws.sessionId },
          "Ping — sending pong"
        );
        sendWs(aws, "pong", aws.sessionId, {});
        break;
      }

      // ── unknown ──────────────────────────────────────────────────────────────
      default: {
        logger.warn(
          { event: "ws.message.unknown_type", type: msg.type, sessionId: aws.sessionId },
          `Unknown WS message type: ${msg.type}`
        );
        sendWs(aws, "error", aws.sessionId, {
          code:    "UNKNOWN_TYPE",
          message: `Unknown message type: ${msg.type}`,
        });
      }
    }

  } catch (err) {
    // Fix #2: pass err directly — not String(err)
    logger.error(
      { event: "ws.message.handler_error", err, sessionId: aws.sessionId, msgType: msg.type },
      "Error handling WS message"
    );
    sendWs(aws, "error", aws.sessionId, {
      code:    "HANDLER_ERROR",
      message: "An error occurred processing your message. Please try again.",
    });
  }
}