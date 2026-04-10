/**
 * InterviewSessionController
 *
 * Single class responsible for the full session lifecycle:
 *   1. Create and start the correct XState v5 actor
 *   2. Run pre-session AI plan generation
 *   3. Route candidate messages to state-specific evaluators
 *   4. Persist every state change and transcript message to Postgres
 *   5. Run final scoring + report generation on completion
 *
 * Identity rule: every DB operation uses our internal UUID (users.id).
 * The Clerk user ID never appears in this file.
 */

import "../lib/env"; // FIRST — loads dotenv before any package initialises

import { createActor } from "xstate";
import type { Actor, Snapshot, SnapshotFrom } from "xstate";
import {
  systemDesignMachine,
  behavioralMachine,
  domainKnowledgeMachine,
} from "@interview/state-machines";
import type {
  SystemDesignMachineContext,
  BehavioralMachineContext,
  DomainKnowledgeMachineContext,
} from "@interview/state-machines";
import {
  db,
  interviewSessions,
  transcriptMessages,
  dimensionScores,
  userInterviewAggregates,
} from "@interview/db";
import { eq, sql } from "drizzle-orm";
import type {
  InterviewType,
  InterviewTier,
  InterviewLevel,
  InterviewPlan,
  CompetencyPlan,
  DomainPlan,
  DimensionScore,
  HireSignal,
  InterviewReport,
  MessageType,
} from "@interview/shared-types";
import {
  generateSystemDesignPlan,
  generateBehavioralPlan,
  generateDomainPlan,
  generateInterviewerResponse,
  computeDimensionScores,
  generateReport,
  detectFirstMove,
  detectStoryExistence,
  parseStarComponents,
  detectAttributionFlag,
  detectMisconceptions,
  assessConfidence,
  classifyProductionDepth,
  scoreCoachability,
} from "@interview/ai-engine";
import { logger } from "../lib/logger";

// ============================================================
// TYPES
// ============================================================

export interface SessionInput {
  sessionId: string;
  userId: string;            // Our internal UUID — never Clerk ID
  type: InterviewType;
  tier: InterviewTier;
  level: InterviewLevel;
  role: string;
  jdText: string | null;
  resumeText: string | null;
  parsedResumeText?: string | null;
  priorSdScore?: number | null;
  priorBehavioralScore?: number | null;
}

/**
 * Merged context type for the session controller.
 * All three machine contexts are intersected so the controller
 * can read any field without per-machine casts everywhere.
 * Fields that only exist on one context are declared optional.
 */
type AnyContext =
  SystemDesignMachineContext &
  BehavioralMachineContext &
  DomainKnowledgeMachineContext & {
    interviewObject?: InterviewPlan | null;
    activeProbeIndex?: number;
  };

type AnyMachine =
  | typeof systemDesignMachine
  | typeof behavioralMachine
  | typeof domainKnowledgeMachine;

type AnyActor = Actor<AnyMachine>;

// Concrete snapshot type that exposes .value and .context.
// Snapshot<unknown> is the erased public type; SnapshotFrom gives us
// the full typed snapshot including value, context, and status.
type AnyMachineSnapshot = SnapshotFrom<AnyMachine>;

interface TranscriptEntry {
  role: "interviewer" | "candidate";
  content: string;
  phase: number;
  stateName: string;
}

// States that indicate the machine has not yet finished pre-session setup.
// handleCandidateResponse rejects messages arriving before INTERVIEW_READY.
const PRE_SESSION_STATES = new Set([
  "IDLE",
  "PARSING_INPUTS",
  "GENERATING_OBJ",
  "QUALITY_GATE",
  "INTERVIEW_READY",
]);

// ============================================================
// IN-MEMORY REGISTRIES
// sessionId → actor / transcript / interview type
// In production: replace with Redis-backed actor snapshot store
// so sessions survive process restarts and scale horizontally.
// ============================================================

const actorRegistry      = new Map<string, AnyActor>();
const transcriptRegistry = new Map<string, TranscriptEntry[]>();
const typeRegistry       = new Map<string, InterviewType>();

// ============================================================
// SESSION CONTROLLER
// ============================================================

export class InterviewSessionController {

  // ─── INITIALIZE ────────────────────────────────────────────

  /**
   * Build the actor, run pre-session plan generation, and wait until
   * the machine reaches INTERVIEW_READY before returning.
   * The HTTP route must await this so the session is fully ready
   * before the 201 response is sent to the client.
   */
  static async initialize(input: SessionInput): Promise<void> {
    logger.info({ sessionId: input.sessionId, type: input.type }, "Initialising session");

    typeRegistry.set(input.sessionId, input.type);

    const actor = InterviewSessionController.buildActor(input);
    logger.info({ sessionId: input.sessionId }, "Actor built");
    actorRegistry.set(input.sessionId, actor);
    transcriptRegistry.set(input.sessionId, []);

    actor.subscribe((snap) => {
      InterviewSessionController.persistSnapshot(input.sessionId, snap).catch(
        (err: unknown) =>
          logger.warn({ err: String(err), sessionId: input.sessionId }, "Snapshot save failed")
      );
    });

    actor.start();
    logger.info({ sessionId: input.sessionId }, "Actor started");
    await InterviewSessionController.runPreSession(input, actor);
  }

  private static buildActor(input: SessionInput): AnyActor {
    const base = {
      sessionId: input.sessionId,
      userId: input.userId,
      role: input.role,
      tier: input.tier,
      level: input.level,
    };

    switch (input.type) {
      case "system_design":
        return createActor(systemDesignMachine, { input: base }) as unknown as AnyActor;

      case "behavioral":
        return createActor(behavioralMachine, { input: base }) as unknown as AnyActor;

      case "domain_knowledge":
        return createActor(domainKnowledgeMachine, {
          input: {
            ...base,
            priorSdScore: input.priorSdScore ?? null,
            priorBehavioralScore: input.priorBehavioralScore ?? null,
          },
        }) as unknown as AnyActor;

      default: {
        const _exhaustive: never = input.type;
        throw new Error(`Unknown interview type: ${String(_exhaustive)}`);
      }
    }
  }

  /**
   * Drive the machine through its pre-session states by:
   *   1. Sending START_SESSION to kick off PARSING_INPUTS
   *   2. Awaiting the AI plan generation
   *   3. Sending INPUTS_PARSED → PLAN_GENERATED → QUALITY_GATE_PASS
   *      sequentially so each state transition completes before the next
   *      event is dispatched
   *
   * This is intentionally sequential and awaited end-to-end.
   * The fire-and-forget pattern in the original caused a race where
   * handleCandidateResponse could arrive while the machine was still
   * sitting in PARSING_INPUTS waiting for an event that hadn't been
   * sent yet.
   */
  private static async runPreSession(
    input: SessionInput,
    actor: AnyActor
  ): Promise<void> {
    actor.send({ type: "START_SESSION" } as never);
    logger.info({ sessionId: input.sessionId }, "START_SESSION sent");
    const effectiveResume = input.parsedResumeText ?? input.resumeText;

    try {
      switch (input.type) {
        case "system_design": {
          const plan = await generateSystemDesignPlan(
            input.role, input.level, input.tier,
            input.jdText, effectiveResume
          );
          logger.info({ sessionId: input.sessionId }, "Plan generated");
          actor.send({ type: "INPUTS_PARSED" } as never);
          actor.send({ type: "PLAN_GENERATED", plan } as never);
          actor.send({ type: "QUALITY_GATE_PASS" } as never);
          break;
        }
        case "behavioral": {
          const plan = await generateBehavioralPlan(
            input.role, input.level, input.jdText, effectiveResume
          );
          logger.info({ sessionId: input.sessionId }, "Plan generated");          
          actor.send({ type: "INPUTS_PARSED" } as never);
          actor.send({ type: "PLAN_GENERATED", plan } as never);
          actor.send({ type: "QUALITY_GATE_PASS" } as never);
          break;
        }
        case "domain_knowledge": {
          const plan = await generateDomainPlan(
            input.role, input.level, input.jdText, effectiveResume
          );
          logger.info({ sessionId: input.sessionId }, "Plan generated");
          actor.send({ type: "INPUTS_PARSED" } as never);
          actor.send({ type: "PLAN_GENERATED", plan } as never);
          actor.send({ type: "QUALITY_GATE_PASS" } as never);
          break;
        }
        default: {
          const _exhaustive: never = input.type;
          throw new Error(`Unknown type in runPreSession: ${String(_exhaustive)}`);
        }
      }

      await db
        .update(interviewSessions)
        .set({ status: "ready", updatedAt: new Date() })
        .where(eq(interviewSessions.id, input.sessionId));

      logger.info({ sessionId: input.sessionId }, "Session ready");
    } catch (err) {
      logger.error({ err: String(err), sessionId: input.sessionId }, "Pre-session failed");
      actor.send({ type: "ERROR", message: String(err) } as never);
      await db
        .update(interviewSessions)
        .set({ status: "abandoned", updatedAt: new Date() })
        .where(eq(interviewSessions.id, input.sessionId));
      throw err; // Re-throw so the route can surface a 500 instead of silently returning 201
    }
  }

  // ─── HANDLE CANDIDATE RESPONSE ─────────────────────────────

  static async handleCandidateResponse(
    sessionId: string,
    content: string,
    userId: string
  ): Promise<{
    interviewerResponse: string;
    stateUpdate: { phase: number; stateName: string };
    isComplete: boolean;
  }> {
    const actor = actorRegistry.get(sessionId);
    if (!actor) throw new Error(`No active actor for session: ${sessionId}`);

    const snap      = actor.getSnapshot() as AnyMachineSnapshot;
    const stateName = InterviewSessionController.snapToStateName(snap);

    // Guard: reject messages that arrive before pre-session is complete.
    // This closes the race between the HTTP 201 response and the background
    // plan-generation work that was previously fire-and-forgot.
    if (PRE_SESSION_STATES.has(stateName)) {
      throw new Error(
        `Session ${sessionId} is not ready yet (state: ${stateName}). ` +
        `Wait for the session status to become "ready" before sending messages.`
      );
    }

    const ctx        = snap.context as unknown as AnyContext;
    const transcript = transcriptRegistry.get(sessionId) ?? [];

    // 1. Record candidate message
    const seqIndex = transcript.length;
    transcript.push({ role: "candidate", content, phase: ctx.phase, stateName });
    await InterviewSessionController.persistMsg(sessionId, {
      sequenceIndex: seqIndex,
      role: "candidate",
      type: "answer",
      content,
      phase: ctx.phase,
      stateName,
      metadata: {},
    });

    // 2. State-specific evaluation — may dispatch extra events to the machine
    await InterviewSessionController.runEval(actor, sessionId, content, ctx, stateName);

    // 3. Advance the state machine
    actor.send({ type: "CANDIDATE_RESPONSE", content } as never);

    const newSnap      = actor.getSnapshot() as AnyMachineSnapshot;
    const newStateName = InterviewSessionController.snapToStateName(newSnap);
    const newCtx       = newSnap.context as unknown as AnyContext;
    const isComplete   = newSnap.status === "done";

    // 4. Generate AI response (unless session is done)
    let interviewerResponse = "";
    if (!isComplete) {
      interviewerResponse = await generateInterviewerResponse({
        interviewType: typeRegistry.get(sessionId) ?? "system_design",
        role: newCtx.role,
        level: newCtx.level,
        currentPhase: newCtx.phase,
        currentState: newStateName,
        transcript: transcript.map((t) => ({ role: t.role, content: t.content })),
        planContext: InterviewSessionController.buildPlanContext(newCtx),
        activeProbeIndex: newCtx.activeProbeIndex ?? 0,
        followUpIntensity:
          (newCtx as BehavioralMachineContext).followUpIntensity ?? "medium",
      });

      transcript.push({
        role: "interviewer",
        content: interviewerResponse,
        phase: newCtx.phase,
        stateName: newStateName,
      });

      await InterviewSessionController.persistMsg(sessionId, {
        sequenceIndex: transcript.length - 1,
        role: "interviewer",
        type: InterviewSessionController.classifyMsgType(newStateName),
        content: interviewerResponse,
        phase: newCtx.phase,
        stateName: newStateName,
        metadata: {},
      });
    }

    // 5. Persist updated session row
    await db
      .update(interviewSessions)
      .set({
        currentPhase: newCtx.phase,
        stateMachineSnapshot: newSnap as unknown as typeof interviewSessions.$inferInsert["stateMachineSnapshot"],
        metadata: {
          durationSeconds: 0,
          totalExchanges: newCtx.totalExchanges,
          silenceEvents: newCtx.silenceEvents,
          probeCount: newCtx.probeCount,
          redirectCount: newCtx.redirectCount,
        },
        updatedAt: new Date(),
      })
      .where(eq(interviewSessions.id, sessionId));

    // 6. Finalize if terminal
    if (isComplete && newStateName === "TERMINAL_COMPLETED") {
      await InterviewSessionController.finalize(sessionId, actor, userId);
    }

    transcriptRegistry.set(sessionId, transcript);

    return {
      interviewerResponse,
      stateUpdate: { phase: newCtx.phase, stateName: newStateName },
      isComplete,
    };
  }

  // ─── STATE-SPECIFIC EVALUATION ─────────────────────────────

  private static async runEval(
    actor: AnyActor,
    sessionId: string,
    content: string,
    ctx: AnyContext,
    stateName: string
  ): Promise<void> {
    try {
      // ── System Design ──────────────────────────────────────
      if (stateName === "FIRST_MOVE_DETECT") {
        const move = await detectFirstMove(content);
        actor.send({
          type: move === "CLARIFY" ? "FIRST_MOVE_CLARIFY" : "FIRST_MOVE_JUMP",
        } as never);
        return;
      }

      // ── Behavioral ─────────────────────────────────────────
      if (stateName === "STORY_EXISTENCE_CHECK") {
        const exists = await detectStoryExistence(content);
        actor.send({ type: "STORY_EXISTS", exists } as never);
        return;
      }

      if (stateName === "STAR_PARSING_LIVE_1") {
        const bCtx    = ctx as BehavioralMachineContext;
        const planItem: CompetencyPlan | undefined =
          bCtx.competencyPlan[bCtx.currentCompetencyIndex];

        if (planItem) {
          const parsed = await parseStarComponents(planItem.competency, content);
          actor.send({ type: "STAR_PARSED", partial: parsed } as never);
          const resultScore = typeof parsed.result === "number" ? parsed.result : 0;
          if (resultScore < 0.4) {
            actor.send({ type: "RESULT_WEAK" } as never);
          } else {
            actor.send({ type: "PHASE_COMPLETE" } as never);
          }
        } else {
          actor.send({ type: "PHASE_COMPLETE" } as never);
        }
        return;
      }

      if (stateName === "ATTRIBUTION_CHECK") {
        const { hasFlag, ratio } = await detectAttributionFlag(content);
        actor.send({ type: "ATTRIBUTION_CHECK_COMPLETE", hasFlag, ratio } as never);
        return;
      }

      // ── Domain Knowledge ───────────────────────────────────
      if (stateName === "MISCONCEPTION_DETECT") {
        const dCtx     = ctx as DomainKnowledgeMachineContext;
        const domainItem: DomainPlan | undefined =
          dCtx.domainPlan[dCtx.currentDomain];

        if (domainItem) {
          const misconceptions = await detectMisconceptions(
            domainItem.domain, content, []
          );
          for (const m of misconceptions) {
            actor.send({ type: "MISCONCEPTION_DETECTED", misconception: m } as never);
          }
        }
        actor.send({ type: "PHASE_COMPLETE" } as never);
        return;
      }

      if (stateName === "CONFIDENCE_CALIBRATE") {
        const { overconfident, underconfident } = await assessConfidence(content);
        actor.send({ type: "CONFIDENCE_ASSESSED", overconfident, underconfident } as never);
        return;
      }

      if (stateName === "TUTORIAL_VS_PROD_CLASSIFY") {
        const { depth, inflation } = await classifyProductionDepth(content);
        actor.send({ type: "TUTORIAL_OR_PROD_CLASSIFIED", depth, inflation } as never);
        return;
      }

      if (stateName === "RESPONSE_CLASSIFY") {
        // Advance the machine immediately; coachability score arrives async
        actor.send({ type: "PHASE_COMPLETE" } as never);
        const transcript = transcriptRegistry.get(sessionId) ?? [];
        const lastInterviewer = [...transcript]
          .reverse()
          .find((m) => m.role === "interviewer");
        const challenge = lastInterviewer?.content ?? "";

        // setImmediate keeps the score dispatch after PHASE_COMPLETE is processed
        setImmediate(() => {
          scoreCoachability(challenge, content)
            .then((score) => {
              actor.send({ type: "COACHABILITY_SCORED", score } as never);
            })
            .catch((err: unknown) =>
              logger.warn({ err: String(err) }, "Coachability score failed")
            );
        });
        return;
      }
    } catch (err) {
      // Evaluation errors are non-fatal — interview continues uninterrupted
      logger.warn(
        { err: String(err), stateName, sessionId },
        "State eval error (non-fatal)"
      );
    }
  }

  // ─── FINALIZE ──────────────────────────────────────────────

  private static async finalize(
    sessionId: string,
    actor: AnyActor,
    userId: string
  ): Promise<void> {
    logger.info({ sessionId }, "Finalising session");

    const session = await db.query.interviewSessions.findFirst({
      where: eq(interviewSessions.id, sessionId),
      columns: { type: true, tier: true },
    });

    if (!session) {
      logger.error({ sessionId }, "Session not found during finalisation");
      return;
    }

    const ctx        = (actor.getSnapshot() as AnyMachineSnapshot).context as unknown as AnyContext;
    const transcript = transcriptRegistry.get(sessionId) ?? [];

    const plan: InterviewPlan | CompetencyPlan[] | DomainPlan[] =
      ctx.interviewObject ??
      (ctx as BehavioralMachineContext).competencyPlan ??
      (ctx as DomainKnowledgeMachineContext).domainPlan ??
      [];

    const scoringTranscript = transcript.map((t) => ({
      role:      t.role,
      content:   t.content,
      phase:     t.phase,
      stateName: t.stateName,
    }));

    const result: {
      scores: DimensionScore[];
      overall: number;
      hireSignal: HireSignal;
    } = await computeDimensionScores(
      session.type,
      scoringTranscript,
      plan,
      session.tier
    );

    const report: InterviewReport = await generateReport(
      session.type,
      sessionId,
      result.scores,
      result.overall,
      result.hireSignal,
      scoringTranscript,
      session.tier
    );

    if (result.scores.length > 0) {
      await db.insert(dimensionScores).values(
        result.scores.map((s) => ({
          sessionId,
          dimension:          s.dimension,
          score:              s.score,
          evidence:           s.evidence,
          transcriptIndices:  s.transcriptIndices,
        }))
      );
    }

    await db
      .update(interviewSessions)
      .set({
        status:       "completed",
        hireSignal:   result.hireSignal,
        overallScore: result.overall,
        report:       report as unknown as typeof interviewSessions.$inferInsert["report"],
        completedAt:  new Date(),
        updatedAt:    new Date(),
      })
      .where(eq(interviewSessions.id, sessionId));

    await db
      .update(userInterviewAggregates)
      .set({
        totalSessions:     sql`total_sessions + 1`,
        completedSessions: sql`completed_sessions + 1`,
        avgOverallScore:   sql`
          (COALESCE(avg_overall_score, 0) * completed_sessions + ${result.overall})
          / (completed_sessions + 1)
        `,
        lastSessionAt: new Date(),
        updatedAt:     new Date(),
      })
      .where(eq(userInterviewAggregates.userId, userId));

    actorRegistry.delete(sessionId);
    transcriptRegistry.delete(sessionId);
    typeRegistry.delete(sessionId);

    logger.info(
      { sessionId, hireSignal: result.hireSignal, overall: result.overall },
      "Session finalised"
    );
  }

  // ─── SNAPSHOT PERSISTENCE ──────────────────────────────────

  private static async persistSnapshot(
    sessionId: string,
    snap: AnyMachineSnapshot
  ): Promise<void> {
    const ctx       = snap.context as unknown as AnyContext;
    const stateName = InterviewSessionController.snapToStateName(snap);

    await db
      .update(interviewSessions)
      .set({
        currentPhase:         ctx.phase,
        stateMachineSnapshot: snap as unknown as typeof interviewSessions.$inferInsert["stateMachineSnapshot"],
        updatedAt:            new Date(),
      })
      .where(eq(interviewSessions.id, sessionId));

    logger.debug({ sessionId, stateName, phase: ctx.phase }, "Snapshot saved");
  }

  // ─── HELPERS ───────────────────────────────────────────────

  static snapToStateName(snap: AnyMachineSnapshot): string {
    const v = snap.value;
    if (typeof v === "string") return v;
    if (v && typeof v === "object") return Object.keys(v)[0] || "UNKNOWN_NESTED";
    return "UNKNOWN";
  }

  private static buildPlanContext(ctx: AnyContext): string {
    if (ctx.interviewObject?.questions?.[0]) {
      return `Current question: ${ctx.interviewObject.questions[0].content}`;
    }
    const bCtx = ctx as BehavioralMachineContext;
    if (Array.isArray(bCtx.competencyPlan) && bCtx.competencyPlan.length > 0) {
      const item = bCtx.competencyPlan[bCtx.currentCompetencyIndex];
      return item
        ? `Competency: ${item.competency}\nQuestion: ${item.question}\nExpected scope: ${item.expectedScope}`
        : "";
    }
    const dCtx = ctx as DomainKnowledgeMachineContext;
    if (Array.isArray(dCtx.domainPlan) && dCtx.domainPlan.length > 0) {
      const item = dCtx.domainPlan[dCtx.currentDomain ?? 0];
      return item ? `Domain: ${item.domain}` : "";
    }
    return "";
  }

  private static classifyMsgType(stateName: string): MessageType {
    const s = stateName.toLowerCase();
    if (s.includes("probe") || s.includes("follow_up")) return "probe";
    if (s.includes("redirect"))                          return "redirect";
    if (s.includes("nudge") || s.includes("silence"))   return "nudge";
    if (s.includes("clos") || s.includes("wrap"))       return "summary";
    if (s.includes("clarif"))                           return "clarification";
    return "question";
  }

  private static async persistMsg(
    sessionId: string,
    msg: {
      sequenceIndex: number;
      role: "interviewer" | "candidate" | "system";
      type: MessageType;
      content: string;
      phase: number;
      stateName: string;
      metadata: Record<string, unknown>;
    }
  ): Promise<void> {
    await db.insert(transcriptMessages).values({
      sessionId,
      sequenceIndex: msg.sequenceIndex,
      role:          msg.role,
      type:          msg.type,
      content:       msg.content,
      phase:         msg.phase,
      stateName:     msg.stateName,
      metadata:      msg.metadata,
    });
  }

  // ─── PUBLIC API ────────────────────────────────────────────

  /** Returns the XState snapshot for an active session (null if not in memory) */
  static getSnapshot(sessionId: string): AnyMachineSnapshot | null {
    return (actorRegistry.get(sessionId)?.getSnapshot() as AnyMachineSnapshot) ?? null;
  }

  /** True if the session actor is currently running in memory */
  static isActive(sessionId: string): boolean {
    return actorRegistry.has(sessionId);
  }

  /** Returns the interview type for a session (registered during initialize) */
  static getType(sessionId: string): InterviewType | undefined {
    return typeRegistry.get(sessionId);
  }
}