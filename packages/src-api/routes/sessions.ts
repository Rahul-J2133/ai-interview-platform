/**
 * apps\api\src\routes\sessions.ts
 * 
 * Session routes — REST API for interview session management.
 * All handlers use our internal UUID (auth.internalUserId) for every DB query.
 *
 * Logging strategy
 * ────────────────
 * Every handler emits structured logs with a stable `event` field at the
 * start, at each significant branch, and at the exit — so the full request
 * lifecycle is traceable from a single sessionId or userId filter.
 *
 *   info   — request received, session created, status changes, request complete
 *   debug  — individual DB queries, validation details, query params
 *   warn   — unexpected but recoverable states (e.g. double-abandon attempt)
 *   error  — unrecoverable failures, 5xx paths
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

// ── CONSTANTS ─────────────────────────────────────────────

/**
 * Maximum time to wait for plan generation before surfacing a 503.
 * AI plan generation (GPT-4 class models) typically takes 3–8 s.
 * 30 s gives headroom while staying inside most serverless platform limits.
 * Override via SESSION_INIT_TIMEOUT_MS env var.
 */
const SESSION_INIT_TIMEOUT_MS = parseInt(
  process.env.SESSION_INIT_TIMEOUT_MS ?? "30000",
  10
);

// ── HELPERS ───────────────────────────────────────────────

/**
 * Races a promise against a deadline.
 * Rejects with a typed error so callers can distinguish timeout from other failures.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out after ${ms}ms: ${label}`)),
        ms
      )
    ),
  ]);
}

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

  // Merge resume fields once — used consistently for both DB insert and initializer.
  // Previously these were merged independently in two places, which could produce
  // different text when only one of the two fields was present.
  const effectiveResumeText = body.parsedResumeText ?? body.resumeText ?? null;

  logger.info(
    {
      event:                "route.session.create.start",
      userId:               auth.internalUserId,
      type:                 body.type,
      tier:                 body.tier,
      level:                body.level,
      role:                 body.role,
      hasJd:                !!body.jdText,
      jdLength:             body.jdText?.length ?? 0,
      hasRawResume:         !!body.resumeText,
      hasParsedResume:      !!body.parsedResumeText,
      effectiveResumeLength: effectiveResumeText?.length ?? 0,
      hasPriorSdScore:      body.priorSdScore != null,
      hasPriorBehavioralScore: body.priorBehavioralScore != null,
      initTimeoutMs:        SESSION_INIT_TIMEOUT_MS,
    },
    "POST /sessions — create session request received"
  );

  try {
    // ── DB insert ──────────────────────────────────────────────
    logger.debug(
      {
        event:  "route.session.create.db_insert",
        userId: auth.internalUserId,
        type:   body.type,
        tier:   body.tier,
        level:  body.level,
        role:   body.role,
      },
      "Inserting session row into DB"
    );

    const [session] = await db
      .insert(interviewSessions)
      .values({
        userId:       auth.internalUserId,
        type:         body.type,
        tier:         body.tier,
        level:        body.level,
        role:         body.role,
        jdText:       body.jdText ?? null,
        resumeText:   effectiveResumeText,
        status:       "initializing",
        currentPhase: 0,
      })
      .returning();

    if (!session) throw new Error("DB insert returned no rows");

    logger.info(
      {
        event:     "route.session.create.db_inserted",
        sessionId: session.id,
        userId:    auth.internalUserId,
        type:      body.type,
        status:    "initializing",
      },
      `Session row created (id=${session.id})`
    );

    // ── Initialize (blocking, with timeout) ───────────────────
    logger.info(
      {
        event:     "route.session.create.init_start",
        sessionId: session.id,
        timeoutMs: SESSION_INIT_TIMEOUT_MS,
      },
      "Starting session initialization (blocking until ready)"
    );

    const initStart = Date.now();

    try {
      await withTimeout(
        InterviewSessionController.initialize({
          sessionId:            session.id,
          userId:               auth.internalUserId,
          type:                 body.type,
          tier:                 body.tier,
          level:                body.level,
          role:                 body.role,
          jdText:               body.jdText ?? null,
          resumeText:           effectiveResumeText,
          priorSdScore:         body.priorSdScore ?? null,
          priorBehavioralScore: body.priorBehavioralScore ?? null,
        }),
        SESSION_INIT_TIMEOUT_MS,
        `session init ${session.id}`
      );

      const initDurationMs = Date.now() - initStart;

      logger.info(
        {
          event:         "route.session.create.init_complete",
          sessionId:     session.id,
          userId:        auth.internalUserId,
          durationMs:    initDurationMs,
        },
        `Session initialized in ${initDurationMs}ms — returning 201`
      );

      return c.json({ data: session, error: null }, 201);

    } catch (initErr) {
      const initDurationMs = Date.now() - initStart;
      const isTimeout      = initErr instanceof Error && initErr.message.startsWith("Timed out");

      logger.error(
        {
          event:         "route.session.create.init_failed",
          err:           initErr,
          sessionId:     session.id,
          userId:        auth.internalUserId,
          durationMs:    initDurationMs,
          isTimeout,
        },
        `Session initialization failed after ${initDurationMs}ms (timeout=${isTimeout})`
      );

      // Defensively mark the row abandoned in case the controller's own cleanup
      // didn't run (e.g. a hard timeout that raced past the catch block inside
      // runPreSession). The WHERE clause guards against clobbering a row the
      // controller may have already moved to "ready" in a tight race.
      logger.debug(
        {
          event:     "route.session.create.abandon_on_init_fail",
          sessionId: session.id,
        },
        "Conditionally marking session abandoned after init failure"
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
          // Return the session ID so the client can reference the abandoned row
          // (e.g. show a "retry" prompt, correlate a support ticket).
          data: { sessionId: session.id },
          error: {
            code:    isTimeout ? "SESSION_INIT_TIMEOUT" : "SESSION_INIT_FAILED",
            message: "Failed to initialise interview session. Please try again.",
          },
        },
        503
      );
    }

  } catch (err) {
    logger.error(
      {
        event:  "route.session.create.failed",
        err,
        userId: auth.internalUserId,
        type:   body.type,
        role:   body.role,
      },
      "Unhandled error during session creation — returning 500"
    );
    return c.json(
      {
        data: null,
        error: { code: "CREATE_FAILED", message: "Failed to create session" },
      },
      500
    );
  }
});

// ── LIST ──────────────────────────────────────────────────

sessions.get("/", async (c) => {
  const auth     = c.get("auth");
  const page     = Math.max(1, parseInt(c.req.query("page")     ?? "1"));
  const pageSize = Math.min(50, Math.max(1, parseInt(c.req.query("pageSize") ?? "10")));
  const rawType   = c.req.query("type")   as InterviewType   | undefined;
  const rawStatus = c.req.query("status") as SessionStatus   | undefined;

  logger.info(
    {
      event:    "route.session.list.start",
      userId:   auth.internalUserId,
      page,
      pageSize,
      filterType:   rawType   ?? null,
      filterStatus: rawStatus ?? null,
    },
    "GET /sessions — list sessions"
  );

  const conditions = [eq(interviewSessions.userId, auth.internalUserId)];
  if (rawType)   conditions.push(eq(interviewSessions.type,   rawType));
  if (rawStatus) conditions.push(eq(interviewSessions.status, rawStatus));

  logger.debug(
    {
      event:          "route.session.list.query",
      userId:         auth.internalUserId,
      conditionCount: conditions.length,
      offset:         (page - 1) * pageSize,
      limit:          pageSize,
    },
    "Querying sessions"
  );

  const data = await db.query.interviewSessions.findMany({
    where:    and(...conditions),
    orderBy:  [desc(interviewSessions.createdAt)],
    limit:    pageSize,
    offset:   (page - 1) * pageSize,
    columns: {
      id:           true,
      type:         true,
      tier:         true,
      level:        true,
      role:         true,
      status:       true,
      currentPhase: true,
      hireSignal:   true,
      overallScore: true,
      createdAt:    true,
      completedAt:  true,
    },
  });

  const hasMore = data.length === pageSize;

  logger.info(
    {
      event:   "route.session.list.complete",
      userId:  auth.internalUserId,
      page,
      pageSize,
      returned: data.length,
      hasMore,
    },
    `List returned ${data.length} sessions (hasMore=${hasMore})`
  );

  return c.json({
    data,
    error: null,
    meta: { page, pageSize, hasMore },
  });
});

// ── GET ───────────────────────────────────────────────────

sessions.get("/:id", async (c) => {
  const auth      = c.get("auth");
  const sessionId = c.req.param("id");

  logger.info(
    { event: "route.session.get.start", sessionId, userId: auth.internalUserId },
    `GET /sessions/${sessionId}`
  );

  const session = await db.query.interviewSessions.findFirst({
    where: and(
      eq(interviewSessions.id,     sessionId),
      eq(interviewSessions.userId, auth.internalUserId)
    ),
  });

  if (!session) {
    logger.warn(
      {
        event:     "route.session.get.not_found",
        sessionId,
        userId:    auth.internalUserId,
      },
      "Session not found or not owned by user"
    );
    return c.json(
      { data: null, error: { code: "NOT_FOUND", message: "Session not found" } },
      404
    );
  }

  logger.debug(
    {
      event:     "route.session.get.found",
      sessionId,
      status:    session.status,
      type:      session.type,
      phase:     session.currentPhase,
    },
    `Session found (status=${session.status})`
  );

  const liveSnapshot = InterviewSessionController.getSnapshot(sessionId);
  const isLive       = !!liveSnapshot;

  const liveState = liveSnapshot
    ? {
        stateName: InterviewSessionController.snapToStateName(liveSnapshot),
        phase:     (liveSnapshot.context as { phase?: number }).phase ?? 0,
        isActive:  true,
      }
    : null;

  logger.info(
    {
      event:     "route.session.get.complete",
      sessionId,
      status:    session.status,
      isLive,
      liveState: liveState?.stateName ?? null,
    },
    `GET /sessions/${sessionId} complete (live=${isLive})`
  );

  return c.json({ data: { ...session, liveState }, error: null });
});

// ── TRANSCRIPT ────────────────────────────────────────────

sessions.get("/:id/transcript", async (c) => {
  const auth      = c.get("auth");
  const sessionId = c.req.param("id");

  logger.info(
    { event: "route.transcript.start", sessionId, userId: auth.internalUserId },
    `GET /sessions/${sessionId}/transcript`
  );

  const owns = await db.query.interviewSessions.findFirst({
    where: and(
      eq(interviewSessions.id,     sessionId),
      eq(interviewSessions.userId, auth.internalUserId)
    ),
    columns: { id: true },
  });

  if (!owns) {
    logger.warn(
      {
        event:     "route.transcript.not_found",
        sessionId,
        userId:    auth.internalUserId,
      },
      "Transcript request rejected — session not found or not owned by user"
    );
    return c.json(
      { data: null, error: { code: "NOT_FOUND", message: "Session not found" } },
      404
    );
  }

  logger.debug(
    { event: "route.transcript.ownership_verified", sessionId },
    "Session ownership verified — fetching messages"
  );

  const messages = await db.query.transcriptMessages.findMany({
    where:   eq(transcriptMessages.sessionId, sessionId),
    orderBy: [transcriptMessages.sequenceIndex],
  });

  logger.info(
    {
      event:        "route.transcript.complete",
      sessionId,
      messageCount: messages.length,
    },
    `Transcript returned: ${messages.length} messages`
  );

  return c.json({ data: messages, error: null });
});

// ── REPORT ────────────────────────────────────────────────

sessions.get("/:id/report", async (c) => {
  const auth      = c.get("auth");
  const sessionId = c.req.param("id");

  logger.info(
    { event: "route.report.start", sessionId, userId: auth.internalUserId },
    `GET /sessions/${sessionId}/report`
  );

  const session = await db.query.interviewSessions.findFirst({
    where: and(
      eq(interviewSessions.id,     sessionId),
      eq(interviewSessions.userId, auth.internalUserId)
    ),
    columns: {
      id:           true,
      status:       true,
      report:       true,
      hireSignal:   true,
      overallScore: true,
      type:         true,
    },
  });

  if (!session) {
    logger.warn(
      {
        event:     "route.report.not_found",
        sessionId,
        userId:    auth.internalUserId,
      },
      "Report request rejected — session not found or not owned by user"
    );
    return c.json(
      { data: null, error: { code: "NOT_FOUND", message: "Session not found" } },
      404
    );
  }

  if (session.status !== "completed") {
    logger.warn(
      {
        event:     "route.report.not_complete",
        sessionId,
        status:    session.status,
      },
      `Report requested for non-completed session (status=${session.status})`
    );
    return c.json(
      { data: null, error: { code: "NOT_COMPLETE", message: "Session not yet complete" } },
      409
    );
  }

  logger.debug(
    {
      event:        "route.report.fetching_scores",
      sessionId,
      hireSignal:   session.hireSignal,
      overallScore: session.overallScore,
    },
    "Fetching dimension scores"
  );

  const scores = await db.query.dimensionScores.findMany({
    where: eq(dimensionScores.sessionId, sessionId),
  });

  logger.info(
    {
      event:          "route.report.complete",
      sessionId,
      hireSignal:     session.hireSignal,
      overallScore:   session.overallScore,
      dimensionCount: scores.length,
    },
    `Report returned (signal=${session.hireSignal}, score=${session.overallScore}, dimensions=${scores.length})`
  );

  return c.json({
    data:  { ...session.report, dimensionScores: scores },
    error: null,
  });
});

// ── ABANDON ───────────────────────────────────────────────

sessions.post("/:id/abandon", async (c) => {
  const auth      = c.get("auth");
  const sessionId = c.req.param("id");

  logger.info(
    { event: "route.session.abandon.start", sessionId, userId: auth.internalUserId },
    `POST /sessions/${sessionId}/abandon`
  );

  const session = await db.query.interviewSessions.findFirst({
    where: and(
      eq(interviewSessions.id,     sessionId),
      eq(interviewSessions.userId, auth.internalUserId)
    ),
    columns: { id: true, status: true },
  });

  if (!session) {
    logger.warn(
      {
        event:     "route.session.abandon.not_found",
        sessionId,
        userId:    auth.internalUserId,
      },
      "Abandon rejected — session not found or not owned by user"
    );
    return c.json(
      { data: null, error: { code: "NOT_FOUND", message: "Session not found" } },
      404
    );
  }

  const abandonable: SessionStatus[] = ["active", "ready", "paused", "initializing"];
  const canAbandon = abandonable.includes(session.status);

  logger.debug(
    {
      event:       "route.session.abandon.status_check",
      sessionId,
      status:      session.status,
      canAbandon,
      abandonable,
    },
    `Abandon status check: status=${session.status}, canAbandon=${canAbandon}`
  );

  if (!canAbandon) {
    logger.warn(
      {
        event:     "route.session.abandon.invalid_status",
        sessionId,
        status:    session.status,
      },
      `Abandon rejected — status=${session.status} is not abandonable`
    );
    return c.json(
      {
        data: null,
        error: {
          code:    "INVALID_STATUS",
          message: `Cannot abandon a session with status: ${session.status}`,
        },
      },
      409
    );
  }

  logger.debug(
    { event: "route.session.abandon.db_update", sessionId, previousStatus: session.status },
    "Writing status=abandoned to DB"
  );

  await db
    .update(interviewSessions)
    .set({ status: "abandoned", updatedAt: new Date() })
    .where(eq(interviewSessions.id, sessionId));

  logger.info(
    {
      event:          "route.session.abandon.complete",
      sessionId,
      userId:         auth.internalUserId,
      previousStatus: session.status,
    },
    `Session abandoned (was ${session.status})`
  );

  return c.json({ data: { abandoned: true }, error: null });
});

export default sessions;