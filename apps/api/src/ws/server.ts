/**
 * WebSocket server for real-time interview communication.
 *
 * Each active interview session gets one persistent WS connection.
 * The server bridges candidate messages → session controller → AI responses.
 */

import "../lib/env"; // ← loads dotenv before db is touched

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
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
// TOKEN VERIFICATION (fast-path decode for WS handshake)
// Full JWKS verification is done in the HTTP auth middleware.
// For WS, we decode the payload, look up internalUserId by clerkUserId.
// ============================================================

async function resolveWsAuth(token: string): Promise<{ internalUserId: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");

  const payloadB64 = parts[1];
  if (!payloadB64) throw new Error("Missing payload segment");

  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as {
    sub?: string;
    exp?: number;
  };

  if (!payload.sub) throw new Error("Token missing sub claim");
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Token expired");
  }

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkUserId, payload.sub))
    .limit(1);

  if (!user) throw new Error(`No internal user found for Clerk sub: ${payload.sub}`);

  return { internalUserId: user.id };
}

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
        logger.debug({ sessionId: aws.sessionId }, "WS dead, terminating");
        aws.terminate();
        return;
      }
      aws.isAlive = false;
      aws.ping();
    });
  }, 30_000);

  wss.on("close", () => clearInterval(heartbeat));

  wss.on("connection", (rawWs: WebSocket, req: IncomingMessage) => {
    const aws = rawWs as AuthenticatedWs;
    aws.isAlive = true;
    aws.on("pong", () => { aws.isAlive = true; });

    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const sessionId = url.searchParams.get("sessionId");
    const token = url.searchParams.get("token");

    if (!sessionId || !token) {
      sendWs(aws, "error", sessionId ?? "unknown", {
        code: "MISSING_PARAMS",
        message: "sessionId and token query params are required",
      });
      aws.close(1008, "Missing params");
      return;
    }

    // Auth + session ownership check
    resolveWsAuth(token)
      .then(async ({ internalUserId }) => {
        const session = await db.query.interviewSessions.findFirst({
          where: eq(interviewSessions.id, sessionId),
          columns: { userId: true, type: true, status: true },
        });

        if (!session || session.userId !== internalUserId) {
          sendWs(aws, "error", sessionId, { code: "UNAUTHORIZED", message: "Session not found or access denied" });
          aws.close(1008, "Unauthorized");
          return;
        }

        if (session.status === "abandoned" || session.status === "completed") {
          sendWs(aws, "error", sessionId, { code: "SESSION_ENDED", message: `Session is ${session.status}` });
          aws.close(1000, "Session ended");
          return;
        }

        aws.sessionId = sessionId;
        aws.internalUserId = internalUserId;

        sessionToWs.set(sessionId, aws);
        logger.info({ sessionId, internalUserId }, "WS connected");

        // Push current state — cast to our known shape to safely access context/value
        const rawSnapshot = InterviewSessionController.getSnapshot(sessionId);
        if (rawSnapshot) {
          const snapshot = rawSnapshot as unknown as SessionSnapshotShape;
          sendWs(aws, "session_state_update", sessionId, {
            phase: snapshot.context.phase ?? 0,
            stateName: typeof snapshot.value === "string" ? snapshot.value : "ACTIVE",
            isComplete: snapshot.status === "done",
          });
        }

        aws.on("message", (raw) => handleMessage(aws, raw));

        aws.on("close", () => {
          sessionToWs.delete(sessionId);
          logger.debug({ sessionId }, "WS disconnected");
        });

        aws.on("error", (err) => {
          logger.error({ err: String(err), sessionId }, "WS error");
        });
      })
      .catch((err: unknown) => {
        logger.warn({ err: String(err) }, "WS auth failed");
        sendWs(aws, "error", sessionId, { code: "AUTH_FAILED", message: "Authentication failed" });
        aws.close(1008, "Auth failed");
      });
  });

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
  } catch {
    sendWs(aws, "error", aws.sessionId, { code: "INVALID_JSON", message: "Could not parse message" });
    return;
  }

  try {
    switch (msg.type) {
      case "candidate_message": {
        const payload = msg.payload as { content?: string } | undefined;
        const content = payload?.content?.trim();
        if (!content) {
          sendWs(aws, "error", aws.sessionId, { code: "EMPTY_MESSAGE", message: "Message content is required" });
          return;
        }

        const result = await InterviewSessionController.handleCandidateResponse(
          aws.sessionId,
          content,
          aws.internalUserId
        );

        if (result.interviewerResponse) {
          sendWs(aws, "interviewer_message", aws.sessionId, {
            content: result.interviewerResponse,
            stateUpdate: result.stateUpdate,
          });
        }

        sendWs(aws, "session_state_update", aws.sessionId, {
          phase: result.stateUpdate.phase,
          stateName: result.stateUpdate.stateName,
          isComplete: result.isComplete,
        });

        if (result.isComplete) {
          sendWs(aws, "session_complete", aws.sessionId, {
            message: "Interview complete. Your report is being generated.",
          });
        }
        break;
      }

      case "silence_event": {
        sendWs(aws, "interviewer_message", aws.sessionId, {
          content: "Take your time — feel free to think aloud.",
          isNudge: true,
        });
        break;
      }

      case "ping": {
        sendWs(aws, "pong", aws.sessionId, {});
        break;
      }

      default:
        logger.debug({ type: msg.type, sessionId: aws.sessionId }, "Unknown WS message type");
    }
  } catch (err) {
    logger.error({ err: String(err), sessionId: aws.sessionId }, "Message handling error");
    sendWs(aws, "error", aws.sessionId, {
      code: "HANDLER_ERROR",
      message: "An error occurred processing your message. Please try again.",
    });
  }
}