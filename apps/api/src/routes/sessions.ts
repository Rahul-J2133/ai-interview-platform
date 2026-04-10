/**
 * Session routes — REST API for interview session management.
 * All handlers use our internal UUID (auth.internalUserId) for every DB query.
 */

import "../lib/env";

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db, interviewSessions, transcriptMessages, dimensionScores } from "@interview/db";
import { eq, desc, and } from "drizzle-orm";
import { InterviewSessionController } from "../services/session-controller";
import { clerkAuthMiddleware } from "../middleware/auth";
import { logger } from "../lib/logger";
import type { InterviewType, SessionStatus } from "@interview/shared-types";

const sessions = new Hono();
sessions.use("*", clerkAuthMiddleware);

// ── CREATE ────────────────────────────────────────────────

const createSessionSchema = z.object({
  type: z.enum(["system_design", "behavioral", "domain_knowledge"]),
  tier: z.enum(["T1", "T2", "T3"]).default("T2"),
  level: z.enum(["junior", "mid", "senior", "staff", "principal"]).default("mid"),
  role: z.string().min(2).max(200),
  jdText: z.string().max(20000).nullable().optional(),
  resumeText: z.string().max(20000).nullable().optional(),
  /** Pre-extracted resume text from doc-parser (takes precedence over resumeText) */
  parsedResumeText: z.string().max(20000).nullable().optional(),
  priorSdScore: z.number().min(0).max(1).nullable().optional(),
  priorBehavioralScore: z.number().min(0).max(1).nullable().optional(),
});

sessions.post("/", zValidator("json", createSessionSchema), async (c) => {
  const auth = c.get("auth");
  const body = c.req.valid("json");

  try {
    const [session] = await db
      .insert(interviewSessions)
      .values({
        userId:       auth.internalUserId,
        type:         body.type,
        tier:         body.tier,
        level:        body.level,
        role:         body.role,
        jdText:       body.jdText ?? null,
        resumeText:   body.parsedResumeText ?? body.resumeText ?? null,
        status:       "initializing",
        currentPhase: 0,
      })
      .returning();

    if (!session) throw new Error("DB insert returned no rows");
    logger.info({ sessionCreatedInDb: true, sessionId: session.id, userId: auth.internalUserId });

    // Await initialize so the 201 only goes out once the machine has reached
    // INTERVIEW_READY. This prevents the client from sending messages before
    // the plan is generated and the actor is ready to receive them.
    try {
      await InterviewSessionController.initialize({
        sessionId:           session.id,
        userId:              auth.internalUserId,
        type:                body.type,
        tier:                body.tier,
        level:               body.level,
        role:                body.role,
        jdText:              body.jdText ?? null,
        resumeText:          body.resumeText ?? null,
        parsedResumeText:    body.parsedResumeText ?? null,
        priorSdScore:        body.priorSdScore ?? null,
        priorBehavioralScore: body.priorBehavioralScore ?? null,
      });
    } catch (initErr) {
      // Pre-session failed (plan generation error, AI timeout, etc.).
      // The controller has already sent ERROR to the actor and set the DB
      // row to "abandoned" — surface a 503 so the client knows not to proceed.
      logger.error(
        { err: String(initErr), sessionId: session.id },
        "Session initialisation failed"
      );
      return c.json(
        {
          data: null,
          error: {
            code: "SESSION_INIT_FAILED",
            message: "Failed to initialise interview session. Please try again.",
          },
        },
        503
      );
    }
    logger.info({ sessionInitialized: true, sessionId: session.id });
    return c.json({ data: session, error: null }, 201);
  } catch (err) {
    logger.error({ err: String(err) }, "Create session failed");
    return c.json(
      {
        data: null,
        error: {
          code: "CREATE_FAILED",
          message: "Failed to create session",
        },
      },
      500
    );
  }
});
// ── LIST ──────────────────────────────────────────────────

sessions.get("/", async (c) => {
  const auth = c.get("auth");
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1"));
  const pageSize = Math.min(50, Math.max(1, parseInt(c.req.query("pageSize") ?? "10")));
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
      id: true,
      type: true,
      tier: true,
      level: true,
      role: true,
      status: true,
      currentPhase: true,
      hireSignal: true,
      overallScore: true,
      createdAt: true,
      completedAt: true,
    },
  });

  return c.json({
    data,
    error: null,
    meta: { page, pageSize, hasMore: data.length === pageSize },
  });
});

// ── GET ───────────────────────────────────────────────────

sessions.get("/:id", async (c) => {
  const auth      = c.get("auth");
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

  // getSnapshot() now returns AnyMachineSnapshot | null, so .context and
  // .value are accessible without a cast. We still narrow .context to
  // pick out just the phase field we need for the response.
  const liveState = liveSnapshot
    ? {
        stateName: InterviewSessionController.snapToStateName(liveSnapshot),
        phase:     (liveSnapshot.context as { phase?: number }).phase ?? 0,
        isActive:  true,
      }
    : null;

  return c.json({ data: { ...session, liveState }, error: null });
});

// ── TRANSCRIPT ────────────────────────────────────────────

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
    return c.json({ data: null, error: { code: "NOT_FOUND", message: "Session not found" } }, 404);
  }

  const messages = await db.query.transcriptMessages.findMany({
    where: eq(transcriptMessages.sessionId, sessionId),
    orderBy: [transcriptMessages.sequenceIndex],
  });

  return c.json({ data: messages, error: null });
});

// ── REPORT ────────────────────────────────────────────────

sessions.get("/:id/report", async (c) => {
  const auth = c.get("auth");
  const sessionId = c.req.param("id");

  const session = await db.query.interviewSessions.findFirst({
    where: and(
      eq(interviewSessions.id, sessionId),
      eq(interviewSessions.userId, auth.internalUserId)
    ),
    columns: { id: true, status: true, report: true, hireSignal: true, overallScore: true, type: true },
  });

  if (!session) {
    return c.json({ data: null, error: { code: "NOT_FOUND", message: "Session not found" } }, 404);
  }
  if (session.status !== "completed") {
    return c.json({ data: null, error: { code: "NOT_COMPLETE", message: "Session not yet complete" } }, 409);
  }

  const scores = await db.query.dimensionScores.findMany({
    where: eq(dimensionScores.sessionId, sessionId),
  });

  return c.json({
    data: { ...session.report, dimensionScores: scores },
    error: null,
  });
});

// ── ABANDON ───────────────────────────────────────────────

sessions.post("/:id/abandon", async (c) => {
  const auth = c.get("auth");
  const sessionId = c.req.param("id");

  const session = await db.query.interviewSessions.findFirst({
    where: and(
      eq(interviewSessions.id, sessionId),
      eq(interviewSessions.userId, auth.internalUserId)
    ),
    columns: { id: true, status: true },
  });

  if (!session) {
    return c.json({ data: null, error: { code: "NOT_FOUND", message: "Session not found" } }, 404);
  }

  const abandonable: SessionStatus[] = ["active", "ready", "paused", "initializing"];
  if (!abandonable.includes(session.status)) {
    return c.json(
      { data: null, error: { code: "INVALID_STATUS", message: `Cannot abandon a session with status: ${session.status}` } },
      409
    );
  }

  await db
    .update(interviewSessions)
    .set({ status: "abandoned", updatedAt: new Date() })
    .where(eq(interviewSessions.id, sessionId));

  return c.json({ data: { abandoned: true }, error: null });
});

export default sessions;
