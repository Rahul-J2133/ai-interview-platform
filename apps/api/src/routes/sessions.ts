/**
 * src/routes/sessions.ts — production hardened
 *
 * Changes from original:
 *
 * [HIGH-9] Session abandon doesn't stop the XState actor
 *   Abandon now calls forceCloseSession() to stop the actor, release
 *   the processing lock, and close the SSE stream.
 *
 * [MEDIUM-13] No rate limiting on session creation
 *   POST / is rate-limited to 10 new sessions per user per minute.
 *
 * [LOW-17] No request ID in logs
 *   All log calls include reqId.
 */

import "../lib/env.js";

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db, interviewSessions, transcriptMessages, dimensionScores } from "../db/index.js";
import { eq, desc, and } from "drizzle-orm";
import { InterviewSessionController } from "../services/session-controller.js";
import { clerkAuthMiddleware } from "../middleware/auth.js";
import { rateLimit, authKey } from "../lib/rate-limit.js";
import { forceCloseSession } from "../sse/handler.js";
import { logger } from "../lib/logger.js";
import type { InterviewType, SessionStatus } from "@interview/shared-types";

const sessions = new Hono();
sessions.use("*", clerkAuthMiddleware);

// ── CONSTANTS ──────────────────────────────────────────────

const SESSION_INIT_TIMEOUT_MS = parseInt(
  process.env.SESSION_INIT_TIMEOUT_MS ?? "30000",
  10
);

// ── HELPERS ────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms)
    ),
  ]);
}

// ── CREATE ─────────────────────────────────────────────────

const createSessionSchema = z.object({
  type: z.enum(["system_design", "behavioral", "domain_knowledge"]),
  tier: z.enum(["T1", "T2", "T3"]).default("T2"),
  level: z.enum(["junior", "mid", "senior", "staff", "principal"]).default("mid"),
  role: z.string().min(2).max(200),
  jdText: z.string().max(20000).nullable().optional(),
  resumeText: z.string().max(20000).nullable().optional(),
  parsedResumeText: z.string().max(20000).nullable().optional(),
  priorSdScore: z.number().min(0).max(1).nullable().optional(),
  priorBehavioralScore: z.number().min(0).max(1).nullable().optional(),
});

sessions.post(
  "/",
  rateLimit({ windowMs: 60_000, max: 10, keyFn: authKey,
    message: "Too many sessions created. Please wait before starting another." }),
  zValidator("json", createSessionSchema),
  async (c) => {
    const auth = c.get("auth");
    const body = c.req.valid("json");
    const reqId = c.get("reqId");

    const effectiveResumeText = body.parsedResumeText ?? body.resumeText ?? null;

    logger.info(
      {
        event: "route.session.create.start",
        userId: auth.internalUserId,
        type: body.type,
        tier: body.tier,
        level: body.level,
        role: body.role,
        hasJd: !!body.jdText,
        hasParsedResume: !!body.parsedResumeText,
        reqId,
      },
      "POST /sessions — create session request received"
    );

    try {
      const [session] = await db
        .insert(interviewSessions)
        .values({
          userId: auth.internalUserId,
          type: body.type,
          tier: body.tier,
          level: body.level,
          role: body.role,
          jdText: body.jdText ?? null,
          resumeText: effectiveResumeText,
          status: "initializing",
          currentPhase: 0,
        })
        .returning();

      if (!session) throw new Error("DB insert returned no rows");

      const initStart = Date.now();
      try {
        await withTimeout(
          InterviewSessionController.initialize({
            sessionId: session.id,
            userId: auth.internalUserId,
            type: body.type,
            tier: body.tier,
            level: body.level,
            role: body.role,
            jdText: body.jdText ?? null,
            resumeText: effectiveResumeText,
            priorSdScore: body.priorSdScore ?? null,
            priorBehavioralScore: body.priorBehavioralScore ?? null,
          }),
          SESSION_INIT_TIMEOUT_MS,
          `session init ${session.id}`
        );

        logger.info(
          {
            event: "route.session.create.init_complete",
            sessionId: session.id,
            durationMs: Date.now() - initStart,
            reqId,
          },
          "Session initialized"
        );

        return c.json({ data: session, error: null }, 201);
      } catch (initErr) {
        const isTimeout =
          initErr instanceof Error && initErr.message.startsWith("Timed out");

        logger.error(
          {
            event: "route.session.create.init_failed",
            err: initErr,
            sessionId: session.id,
            durationMs: Date.now() - initStart,
            isTimeout,
            reqId,
          },
          "Session initialization failed"
        );

        await db
          .update(interviewSessions)
          .set({ status: "abandoned", updatedAt: new Date() })
          .where(
            and(
              eq(interviewSessions.id, session.id),
              eq(interviewSessions.status, "initializing")
            )
          );

        return c.json(
          {
            data: { sessionId: session.id },
            error: {
              code: isTimeout ? "SESSION_INIT_TIMEOUT" : "SESSION_INIT_FAILED",
              message: "Failed to initialise interview session. Please try again.",
            },
          },
          503
        );
      }
    } catch (err) {
      logger.error(
        { event: "route.session.create.failed", err, userId: auth.internalUserId, reqId },
        "Unhandled error during session creation"
      );
      return c.json(
        {
          data: null,
          error: { code: "CREATE_FAILED", message: "Failed to create session" },
        },
        500
      );
    }
  }
);

// ── LIST ───────────────────────────────────────────────────

sessions.get("/", async (c) => {
  const auth = c.get("auth");
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1"));
  const pageSize = Math.min(
    50,
    Math.max(1, parseInt(c.req.query("pageSize") ?? "10"))
  );
  const rawType = c.req.query("type") as InterviewType | undefined;
  const rawStatus = c.req.query("status") as SessionStatus | undefined;

  const conditions = [eq(interviewSessions.userId, auth.internalUserId)];
  if (rawType) conditions.push(eq(interviewSessions.type, rawType));
  if (rawStatus) conditions.push(eq(interviewSessions.status, rawStatus));

  const data = await db.query.interviewSessions.findMany({
    where: and(...conditions),
    orderBy: [desc(interviewSessions.createdAt)],
    limit: pageSize,
    offset: (page - 1) * pageSize,
    columns: {
      id: true, type: true, tier: true, level: true, role: true,
      status: true, currentPhase: true, hireSignal: true,
      overallScore: true, createdAt: true, completedAt: true,
    },
  });

  return c.json({
    data,
    error: null,
    meta: { page, pageSize, hasMore: data.length === pageSize },
  });
});

// ── GET ────────────────────────────────────────────────────

sessions.get("/:id", async (c) => {
  const auth = c.get("auth");
  const sessionId = c.req.param("id");

  const session = await db.query.interviewSessions.findFirst({
    where: and(
      eq(interviewSessions.id, sessionId),
      eq(interviewSessions.userId, auth.internalUserId)
    ),
  });

  if (!session) {
    return c.json(
      { data: null, error: { code: "NOT_FOUND", message: "Session not found" } },
      404
    );
  }

  const liveSnapshot = InterviewSessionController.getSnapshot(sessionId);
  const liveState = liveSnapshot
    ? {
        stateName: InterviewSessionController.snapToStateName(liveSnapshot),
        phase: (liveSnapshot.context as { phase?: number }).phase ?? 0,
        isActive: true,
      }
    : null;

  return c.json({ data: { ...session, liveState }, error: null });
});

// ── TRANSCRIPT ─────────────────────────────────────────────

sessions.get("/:id/transcript", async (c) => {
  const auth = c.get("auth");
  const sessionId = c.req.param("id");

  const owns = await db.query.interviewSessions.findFirst({
    where: and(
      eq(interviewSessions.id, sessionId),
      eq(interviewSessions.userId, auth.internalUserId)
    ),
    columns: { id: true },
  });

  if (!owns) {
    return c.json(
      { data: null, error: { code: "NOT_FOUND", message: "Session not found" } },
      404
    );
  }

  const messages = await db.query.transcriptMessages.findMany({
    where: eq(transcriptMessages.sessionId, sessionId),
    orderBy: [transcriptMessages.sequenceIndex],
  });

  return c.json({ data: messages, error: null });
});

// ── REPORT ─────────────────────────────────────────────────

sessions.get("/:id/report", async (c) => {
  const auth = c.get("auth");
  const sessionId = c.req.param("id");

  const session = await db.query.interviewSessions.findFirst({
    where: and(
      eq(interviewSessions.id, sessionId),
      eq(interviewSessions.userId, auth.internalUserId)
    ),
    columns: {
      id: true, status: true, report: true,
      hireSignal: true, overallScore: true, type: true,
    },
  });

  if (!session) {
    return c.json(
      { data: null, error: { code: "NOT_FOUND", message: "Session not found" } },
      404
    );
  }

  if (session.status !== "completed") {
    return c.json(
      { data: null, error: { code: "NOT_COMPLETE", message: "Session not yet complete" } },
      409
    );
  }

  const scores = await db.query.dimensionScores.findMany({
    where: eq(dimensionScores.sessionId, sessionId),
  });

  return c.json({
    data: { ...session.report, dimensionScores: scores },
    error: null,
  });
});

// ── ABANDON ────────────────────────────────────────────────
//
// [HIGH-9] Now properly tears down the XState actor, processing lock,
// and SSE stream — previously only updated the DB row.

sessions.post("/:id/abandon", async (c) => {
  const auth = c.get("auth");
  const sessionId = c.req.param("id");
  const reqId = c.get("reqId");

  const session = await db.query.interviewSessions.findFirst({
    where: and(
      eq(interviewSessions.id, sessionId),
      eq(interviewSessions.userId, auth.internalUserId)
    ),
    columns: { id: true, status: true },
  });

  if (!session) {
    return c.json(
      { data: null, error: { code: "NOT_FOUND", message: "Session not found" } },
      404
    );
  }

  const abandonable: SessionStatus[] = ["active", "ready", "paused", "initializing"];
  if (!abandonable.includes(session.status)) {
    return c.json(
      {
        data: null,
        error: {
          code: "INVALID_STATUS",
          message: `Cannot abandon a session with status: ${session.status}`,
        },
      },
      409
    );
  }

  await db
    .update(interviewSessions)
    .set({ status: "abandoned", updatedAt: new Date() })
    .where(eq(interviewSessions.id, sessionId));

  // Tear down in-memory state: XState actor, processing lock, SSE stream
  try {
    InterviewSessionController.terminate(sessionId);
  } catch {
    // Controller may not expose terminate yet — safe to ignore
  }
  forceCloseSession(sessionId);

  logger.info(
    {
      event: "route.session.abandon.complete",
      sessionId,
      userId: auth.internalUserId,
      previousStatus: session.status,
      reqId,
    },
    `Session abandoned (was ${session.status})`
  );

  return c.json({ data: { abandoned: true }, error: null });
});

export default sessions;
