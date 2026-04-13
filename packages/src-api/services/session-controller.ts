/**
 * 
 * apps\api\src\services\session-controller.ts
 * 
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
 *
 * Logging strategy
 * ────────────────
 * Every meaningful step emits a structured log with a stable `event` field
 * so logs can be searched/filtered by event name independently of the
 * human-readable message string. Levels follow this convention:
 *
 *   trace  — high-frequency internal steps (microtask yields, snapshot writes)
 *   debug  — per-message steps useful during development
 *   info   — lifecycle milestones (session created, plan generated, completed)
 *   warn   — recoverable anomalies (non-fatal eval errors, snapshot save failures)
 *   error  — unrecoverable failures that abort a session or request
 */

import "../lib/env"; // FIRST — loads dotenv before any package initialises

import { createActor } from "xstate";
import type { Actor, SnapshotFrom } from "xstate";
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
  /**
   * Resolved resume text — callers must merge parsedResumeText ?? resumeText
   * before constructing this input. The controller no longer accepts two
   * separate resume fields to avoid the DB/AI divergence that previously
   * occurred when only one field was provided.
   */
  resumeText: string | null;
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
type AnyMachineSnapshot = SnapshotFrom<AnyMachine>;

interface TranscriptEntry {
  role: "interviewer" | "candidate";
  content: string;
  phase: number;
  stateName: string;
}

// States in which the machine has not yet reached its first live interview state.
// handleCandidateResponse rejects messages arriving while any of these is active.
//
// These must exactly match the state node names defined in the XState machines.
// domain_knowledge machine pre-session states (document 6):
//   IDLE → DOMAIN_TAXONOMY_LOAD → RESUME_DOMAIN_PARSE → DOMAIN_PLAN_GEN
//   → QUALITY_GATE → PLAN_READY → (CANDIDATE_READY) → CONCEPTUAL_QUESTION (live)
// system_design and behavioral machines follow the same terminal pattern:
//   IDLE → … → QUALITY_GATE → PLAN_READY → (CANDIDATE_READY) → first live state
//
// PLAN_READY is included because the machine is in this state between
// QUALITY_GATE_PASS and CANDIDATE_READY — the session is not yet live.
const PRE_SESSION_STATES = new Set([
  "IDLE",
  // system_design machine pre-session states (document 8)
  //   IDLE → PARSING_INPUTS → GENERATING_OBJ → QUALITY_GATE → INTERVIEW_READY → DELIVERING (live)
  "PARSING_INPUTS",
  "GENERATING_OBJ",
  "INTERVIEW_READY",
  // behavioral machine pre-session states (document 7)
  //   IDLE → PARSING_RESUME → JD_COMPETENCY_MAP → COMPETENCY_PLAN_GEN → QUALITY_GATE → PLAN_READY → CONTEXT_SETTING (live)
  "PARSING_RESUME",
  "JD_COMPETENCY_MAP",
  "COMPETENCY_PLAN_GEN",
  // domain_knowledge machine pre-session states (document 6)
  //   IDLE → DOMAIN_TAXONOMY_LOAD → RESUME_DOMAIN_PARSE → DOMAIN_PLAN_GEN → QUALITY_GATE → PLAN_READY → CONCEPTUAL_QUESTION (live)
  "DOMAIN_TAXONOMY_LOAD",
  "RESUME_DOMAIN_PARSE",
  "DOMAIN_PLAN_GEN",
  // shared across behavioral and domain_knowledge
  "QUALITY_GATE",
  "PLAN_READY",
]);

// States where the machine genuinely pauses and waits for the next candidate input.
// When the machine lands here after processing a response, the turn is complete
// and control returns to the WS layer.
//
// Every state NOT in this set (and not terminal) is an intermediate state that
// must be driven through immediately in the same turn via pumpToRest().
//
// system_design (document 8):
const CANDIDATE_AWAITING_STATES = new Set([
  // system_design
  "DELIVERING", "SILENCE_WATCH", "SILENCE_NUDGE_ISSUED",
  "CLARIFYING", "ESTIMATING", "SCAFFOLDING_CHECK",
  "HLD_LISTENING", "PROBE_ISSUE", "DATA_LAYER_REDIRECT",
  "TRADEOFF_CHALLENGE", "FAILURE_MODE_PROBE", "SCALE_STRESS_TEST",
  "SELF_CRITIQUE_PROMPT", "CANDIDATE_QA",
  // behavioral
  "CONTEXT_SETTING", "BASELINE_QUESTION", "DELIVERING_Q1",
  "RESULT_DEPTH_PROBE_1", "ADVERSITY_QUESTION", "ACCOUNTABILITY_PROBE",
  "INFLUENCE_QUESTION", "STAKEHOLDER_PROBE",
  // behavioral — fallback resting state (waits for CANDIDATE_RESPONSE unless
  // fallbackAlsoFailed guard fires synchronously on entry via always:)
  "FALLBACK_PROMPT",
  // domain_knowledge
  "CONCEPTUAL_QUESTION", "APPLIED_QUESTION", "WAR_STORY_PROBE",
  "EDGE_CASE_QUESTION", "ADJACENT_DOMAIN_TEST", "D2_FLOWING_CONVO",
  "STRETCH_FRAMING", "FIRST_PRINCIPLES_TEST", "LEARNING_VELOCITY",
  "DELIBERATE_CHALLENGE",
]);

const TERMINAL_STATES = new Set(["TERMINAL_COMPLETED", "ERROR_STATE"]);

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
// MODULE-LEVEL HELPERS
// (defined here so sendAndSettle can use snapToStateName before the class)
// ============================================================

/**
 * Yields to the macrotask queue (one full event-loop tick) so XState v5
 * can fully commit every in-flight transition before the next event is sent.
 *
 * Why a macrotask instead of a microtask
 * ───────────────────────────────────────
 * XState v5 processes the state transition itself synchronously on actor.send(),
 * but it defers two categories of work to later ticks:
 *
 *   1. Microtask-deferred: entry action scheduling, context assignment.
 *      One Promise.resolve() covers this.
 *
 *   2. Macrotask-deferred: `after` delayed-transition setup (setTimeout(0)),
 *      invoked actor (service) initialization.
 *      States with `after: { [ms]: "TARGET" }` — like CONCEPTUAL_QUESTION,
 *      APPLIED_QUESTION, ADVERSITY_QUESTION, etc. — schedule their timer via
 *      setTimeout. Until that setTimeout callback runs, XState considers the
 *      state "not fully settled" and can silently discard incoming events.
 *
 * Using setImmediate (which runs AFTER all pending setTimeout(0) callbacks)
 * guarantees the machine has fully committed every entry action and timer
 * setup before the next send() call arrives.
 *
 * Performance: setImmediate adds ~0ms real latency in Node.js. The additional
 * yield is negligible compared to the AI API calls surrounding each send.
 */
const yieldMacrotask = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/** Standalone state-name extractor — mirrors the static method on the class. */
function snapToStateName(snap: AnyMachineSnapshot): string {
  const v = snap.value;
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return Object.keys(v)[0] || "UNKNOWN_NESTED";
  return "UNKNOWN";
}

/**
 * sendAndSettle — send an XState event, yield one microtask so the machine
 * finishes transitioning, then log the before/after state pair at trace level.
 *
 * Using this wrapper everywhere gives us a complete, searchable record of
 * every event sent and every state transition in the logs without having to
 * manually add logging around each individual send.
 */
async function sendAndSettle(
  actor: AnyActor,
  event: Record<string, unknown> & { type: string },
  sessionId: string
): Promise<void> {
  const stateBefore = snapToStateName(actor.getSnapshot() as AnyMachineSnapshot);
  logger.trace(
    { event: "xstate.send", sessionId, eventType: event.type, stateBefore },
    `→ Sending ${event.type} (in ${stateBefore})`
  );

  actor.send(event as never);
  await yieldMacrotask();

  const stateAfter  = snapToStateName(actor.getSnapshot() as AnyMachineSnapshot);
  const transitioned = stateBefore !== stateAfter;
  logger.trace(
    {
      event:       "xstate.transition",
      sessionId,
      eventType:   event.type,
      stateBefore,
      stateAfter,
      transitioned,
    },
    transitioned
      ? `✓ ${event.type}: ${stateBefore} → ${stateAfter}`
      : `~ ${event.type}: stayed in ${stateBefore}`
  );
}

// ============================================================
// SESSION CONTROLLER
// ============================================================

export class InterviewSessionController {

  // ─── INITIALIZE ────────────────────────────────────────────

  /**
   * Build the actor, run pre-session plan generation, and wait until
   * the machine reaches its first live interview state before returning.
   * The HTTP route must await this so the session is fully ready
   * before the 201 response is sent to the client.
   */
  static async initialize(input: SessionInput): Promise<void> {
    logger.info(
      {
        event:                  "session.initialize.start",
        sessionId:              input.sessionId,
        userId:                 input.userId,
        type:                   input.type,
        tier:                   input.tier,
        level:                  input.level,
        role:                   input.role,
        hasJd:                  !!input.jdText,
        jdLength:               input.jdText?.length ?? 0,
        hasResume:              !!input.resumeText,
        resumeLength:           input.resumeText?.length ?? 0,
        hasPriorSdScore:        input.priorSdScore != null,
        hasPriorBehavioralScore: input.priorBehavioralScore != null,
      },
      "Session initialisation started"
    );

    typeRegistry.set(input.sessionId, input.type);
    logger.trace(
      { event: "registry.type.set", sessionId: input.sessionId, type: input.type },
      "Type registry updated"
    );

    const actor = InterviewSessionController.buildActor(input);
    actorRegistry.set(input.sessionId, actor);
    transcriptRegistry.set(input.sessionId, []);

    logger.info(
      {
        event:         "session.actor.registered",
        sessionId:     input.sessionId,
        type:          input.type,
        registrySize:  actorRegistry.size,
      },
      "Actor built and registered in memory"
    );

    // Subscribe for trace logging only. Snapshot persistence is handled by
    // the explicit db.update in handleCandidateResponse (after pump settles).
    // Writing on every subscription emission causes a write storm — up to 10
    // concurrent UPDATEs on the same row per pumpToRest() call.
    actor.subscribe((snap) => {
      const stateName = snapToStateName(snap as AnyMachineSnapshot);
      logger.trace(
        {
          event:     "xstate.snapshot.received",
          sessionId: input.sessionId,
          stateName,
          status:    snap.status,
        },
        `Snapshot received: ${stateName}`
      );
    });

    actor.start();
    logger.info(
      { event: "session.actor.started", sessionId: input.sessionId },
      "Actor started"
    );

    await InterviewSessionController.runPreSession(input, actor);
  }

  // ─── BUILD ACTOR ───────────────────────────────────────────

  private static buildActor(input: SessionInput): AnyActor {
    logger.debug(
      {
        event:     "session.actor.create",
        sessionId: input.sessionId,
        type:      input.type,
        tier:      input.tier,
        level:     input.level,
        role:      input.role,
      },
      `Creating ${input.type} actor`
    );

    const base = {
      sessionId: input.sessionId,
      userId:    input.userId,
      role:      input.role,
      tier:      input.tier,
      level:     input.level,
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
            priorSdScore:         input.priorSdScore ?? null,
            priorBehavioralScore: input.priorBehavioralScore ?? null,
          },
        }) as unknown as AnyActor;

      default: {
        const _exhaustive: never = input.type;
        throw new Error(`Unknown interview type: ${String(_exhaustive)}`);
      }
    }
  }

  // ─── PRE-SESSION ───────────────────────────────────────────

  /**
   * Drive the machine through its pre-session states.
   *
   * Each send is wrapped in sendAndSettle() which logs the transition at
   * trace level and yields one microtask so the machine is fully stable
   * before the next event is dispatched (fixes stuck-at-parsing bug).
   *
   * Event sequences per machine type
   * ─────────────────────────────────
   * system_design / behavioral (state names TBC when those machines are provided):
   *   START_SESSION → [plan] → INPUTS_PARSED → PLAN_GENERATED → QUALITY_GATE_PASS
   *   → CANDIDATE_READY
   *
   * domain_knowledge (verified against document 6):
   *   START_SESSION  → DOMAIN_TAXONOMY_LOAD
   *   INPUTS_PARSED  → RESUME_DOMAIN_PARSE
   *   PHASE_COMPLETE → DOMAIN_PLAN_GEN          ← skipped in old code = stuck here
   *   PLAN_GENERATED → QUALITY_GATE
   *   QUALITY_GATE_PASS → PLAN_READY
   *   CANDIDATE_READY → CONCEPTUAL_QUESTION     ← skipped in old code = stuck at PLAN_READY
   */
  private static async runPreSession(
    input: SessionInput,
    actor: AnyActor
  ): Promise<void> {
    logger.info(
      {
        event:     "presession.start",
        sessionId: input.sessionId,
        type:      input.type,
      },
      "Pre-session phase started"
    );

    await sendAndSettle(actor, { type: "START_SESSION" }, input.sessionId);

    try {
      // ── AI plan generation ──────────────────────────────────
      logger.info(
        {
          event:     "presession.plan.generating",
          sessionId: input.sessionId,
          type:      input.type,
          role:      input.role,
          level:     input.level,
          tier:      input.tier,
          hasJd:     !!input.jdText,
          hasResume: !!input.resumeText,
        },
        "Calling AI plan generator"
      );

      const planStartMs = Date.now();

      switch (input.type) {
        case "system_design": {
          const plan = await generateSystemDesignPlan(
            input.role, input.level, input.tier,
            input.jdText, input.resumeText
          );
          logger.info(
            {
              event:         "presession.plan.generated",
              sessionId:     input.sessionId,
              type:          "system_design",
              durationMs:    Date.now() - planStartMs,
              questionCount: plan?.questions?.length ?? 0,
            },
            `System-design plan generated in ${Date.now() - planStartMs}ms`
          );

          await sendAndSettle(actor, { type: "INPUTS_PARSED" },       input.sessionId);
          await sendAndSettle(actor, { type: "PLAN_GENERATED", plan }, input.sessionId);
          await sendAndSettle(actor, { type: "QUALITY_GATE_PASS" },   input.sessionId);
          // CANDIDATE_READY advances from PLAN_READY to the first live interview state.
          // Verify state name matches system_design machine's PLAN_READY → on CANDIDATE_READY target.
          await sendAndSettle(actor, { type: "CANDIDATE_READY" },     input.sessionId);
          break;
        }

        case "behavioral": {
          const plan = await generateBehavioralPlan(
            input.role, input.level, input.jdText, input.resumeText
          );
          logger.info(
            {
              event:           "presession.plan.generated",
              sessionId:       input.sessionId,
              type:            "behavioral",
              durationMs:      Date.now() - planStartMs,
              competencyCount: plan?.length ?? 0,
            },
            `Behavioral plan generated in ${Date.now() - planStartMs}ms`
          );

          // INPUTS_PARSED: PARSING_RESUME → JD_COMPETENCY_MAP
          await sendAndSettle(actor, { type: "INPUTS_PARSED" },       input.sessionId);
          // PHASE_COMPLETE: JD_COMPETENCY_MAP → COMPETENCY_PLAN_GEN
          // (this was missing — JD_COMPETENCY_MAP only accepts PHASE_COMPLETE,
          //  so PLAN_GENERATED was silently dropped and the machine stuck here)
          await sendAndSettle(actor, { type: "PHASE_COMPLETE" },       input.sessionId);
          // PLAN_GENERATED: COMPETENCY_PLAN_GEN → QUALITY_GATE
          await sendAndSettle(actor, { type: "PLAN_GENERATED", plan }, input.sessionId);
          // QUALITY_GATE_PASS: QUALITY_GATE → PLAN_READY
          await sendAndSettle(actor, { type: "QUALITY_GATE_PASS" },   input.sessionId);
          // CANDIDATE_READY: PLAN_READY → CONTEXT_SETTING (first live state)
          await sendAndSettle(actor, { type: "CANDIDATE_READY" },     input.sessionId);
          break;
        }

        case "domain_knowledge": {
          const plan = await generateDomainPlan(
            input.role, input.level, input.jdText, input.resumeText
          );
          logger.info(
            {
              event:       "presession.plan.generated",
              sessionId:   input.sessionId,
              type:        "domain_knowledge",
              durationMs:  Date.now() - planStartMs,
              domainCount: plan?.length ?? 0,
            },
            `Domain-knowledge plan generated in ${Date.now() - planStartMs}ms`
          );

          // INPUTS_PARSED: DOMAIN_TAXONOMY_LOAD → RESUME_DOMAIN_PARSE
          await sendAndSettle(actor, { type: "INPUTS_PARSED" },       input.sessionId);
          // PHASE_COMPLETE: RESUME_DOMAIN_PARSE → DOMAIN_PLAN_GEN
          // (this send was missing — caused the stuck-at-parsing bug for domain_knowledge)
          await sendAndSettle(actor, { type: "PHASE_COMPLETE" },       input.sessionId);
          // PLAN_GENERATED: DOMAIN_PLAN_GEN → QUALITY_GATE
          await sendAndSettle(actor, { type: "PLAN_GENERATED", plan }, input.sessionId);
          // QUALITY_GATE_PASS: QUALITY_GATE → PLAN_READY
          await sendAndSettle(actor, { type: "QUALITY_GATE_PASS" },   input.sessionId);
          // CANDIDATE_READY: PLAN_READY → CONCEPTUAL_QUESTION (first live state)
          // (this send was also missing — session was stuck in PLAN_READY)
          await sendAndSettle(actor, { type: "CANDIDATE_READY" },     input.sessionId);
          break;
        }

        default: {
          const _exhaustive: never = input.type;
          throw new Error(`Unknown type in runPreSession: ${String(_exhaustive)}`);
        }
      }

      // ── Write ready status to DB ────────────────────────────
      const finalStateName = snapToStateName(actor.getSnapshot() as AnyMachineSnapshot);
      logger.debug(
        {
          event:        "presession.db.status_ready",
          sessionId:    input.sessionId,
          machineState: finalStateName,
        },
        "Writing status=ready to DB"
      );

      await db
        .update(interviewSessions)
        .set({ status: "ready", updatedAt: new Date() })
        .where(eq(interviewSessions.id, input.sessionId));

      logger.info(
        {
          event:        "presession.complete",
          sessionId:    input.sessionId,
          machineState: finalStateName,
        },
        "Pre-session complete — session is ready for candidate messages"
      );

    } catch (err) {
      const machineState = snapToStateName(actor.getSnapshot() as AnyMachineSnapshot);
      logger.error(
        {
          event:        "presession.failed",
          err,
          sessionId:    input.sessionId,
          type:         input.type,
          machineState,
        },
        "Pre-session failed — abandoning session"
      );

      await sendAndSettle(
        actor,
        { type: "ERROR", message: String(err) },
        input.sessionId
      );

      logger.debug(
        { event: "presession.db.status_abandoned", sessionId: input.sessionId },
        "Writing status=abandoned to DB"
      );

      await db
        .update(interviewSessions)
        .set({ status: "abandoned", updatedAt: new Date() })
        .where(eq(interviewSessions.id, input.sessionId));

      throw err; // Re-throw so the route surfaces a 503
    }
  }

  // ─── HANDLE CANDIDATE RESPONSE ─────────────────────────────

  static async handleCandidateResponse(
    sessionId: string,
    content: string,
    userId: string,
    /**
     * Optional streaming callback. When provided, the AI response is streamed
     * chunk-by-chunk via this callback as it arrives from Groq. The resolved
     * `interviewerResponse` in the return value will be the complete accumulated
     * text (identical to the non-streaming case), so callers that don't stream
     * can still read the full string from the return value.
     *
     * The WS server passes a function that sends `interviewer_chunk` frames so
     * the client can render tokens as they arrive instead of waiting 3–6 s for
     * the full response.
     */
    onChunk?: (chunk: string) => void
  ): Promise<{
    interviewerResponse: string;
    stateUpdate: { phase: number; stateName: string };
    isComplete: boolean;
  }> {
    logger.debug(
      {
        event:         "candidate.response.received",
        sessionId,
        contentLength: content.length,
        preview:       content.slice(0, 120),
      },
      "Candidate response received"
    );

    // ── 1. Actor lookup — with snapshot recovery ───────────────
    let actor = actorRegistry.get(sessionId);
    if (!actor) {
      logger.warn(
        { event: "candidate.response.actor_missing", sessionId },
        "Actor not in memory — attempting DB snapshot recovery"
      );

      const row = await db.query.interviewSessions.findFirst({
        where:   eq(interviewSessions.id, sessionId),
        columns: { stateMachineSnapshot: true, type: true, status: true },
      });

      if (!row || !row.stateMachineSnapshot) {
        logger.error(
          { event: "candidate.response.no_actor_no_snapshot", sessionId },
          "No actor and no DB snapshot — session unrecoverable"
        );
        throw new Error(
          `No active actor for session: ${sessionId}. ` +
          `Session may have ended or the server restarted without a persisted snapshot.`
        );
      }

      if (row.status === "completed" || row.status === "abandoned") {
        throw new Error(`Session ${sessionId} is already ${row.status}`);
      }

      logger.info(
        { event: "candidate.response.actor_recovered", sessionId, type: row.type },
        "Rebuilding actor from DB snapshot"
      );

      typeRegistry.set(sessionId, row.type as InterviewType);

      let machine: AnyMachine;
      switch (row.type as InterviewType) {
        case "system_design":    machine = systemDesignMachine as unknown as AnyMachine; break;
        case "behavioral":       machine = behavioralMachine as unknown as AnyMachine; break;
        case "domain_knowledge": machine = domainKnowledgeMachine as unknown as AnyMachine; break;
        default: throw new Error(`Unknown interview type: ${row.type}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const restoredActor = createActor(machine, { snapshot: row.stateMachineSnapshot as any }) as unknown as AnyActor;
      restoredActor.start();
      actorRegistry.set(sessionId, restoredActor);
      transcriptRegistry.set(sessionId, []);
      actor = restoredActor;

      logger.info(
        {
          event:          "candidate.response.actor_recovery_complete",
          sessionId,
          recoveredState: snapToStateName(restoredActor.getSnapshot() as AnyMachineSnapshot),
        },
        "Actor recovery complete"
      );
    }

    const snap      = actor.getSnapshot() as AnyMachineSnapshot;
    const stateName = snapToStateName(snap);
    const ctx       = snap.context as unknown as AnyContext;

    logger.debug(
      {
        event:          "candidate.response.state_check",
        sessionId,
        stateName,
        phase:          ctx.phase,
        totalExchanges: ctx.totalExchanges,
        probeCount:     ctx.probeCount,
        redirectCount:  ctx.redirectCount,
        silenceEvents:  ctx.silenceEvents,
      },
      `Machine state: ${stateName} (phase ${ctx.phase}, exchanges ${ctx.totalExchanges})`
    );

    // ── 2. Pre-session guard ───────────────────────────────────
    if (PRE_SESSION_STATES.has(stateName)) {
      logger.warn(
        {
          event:         "candidate.response.rejected_early",
          sessionId,
          stateName,
          contentLength: content.length,
        },
        "Rejecting candidate message — session not yet in ready state"
      );
      throw new Error(
        `Session ${sessionId} is not ready yet (state: ${stateName}). ` +
        `Wait for the session status to become "ready" before sending messages.`
      );
    }

    const transcript = transcriptRegistry.get(sessionId) ?? [];
    const seqIndex   = transcript.length;

    // ── 3. Persist candidate message ───────────────────────────
    logger.debug(
      {
        event:     "candidate.message.persisting",
        sessionId,
        seqIndex,
        phase:     ctx.phase,
        stateName,
      },
      `Persisting candidate message (seq=${seqIndex})`
    );

    transcript.push({ role: "candidate", content, phase: ctx.phase, stateName });

    await InterviewSessionController.persistMsg(sessionId, {
      sequenceIndex: seqIndex,
      role:          "candidate",
      type:          "answer",
      content,
      phase:         ctx.phase,
      stateName,
      metadata:      {},
    });

    logger.debug(
      { event: "candidate.message.persisted", sessionId, seqIndex },
      `Candidate message persisted (seq=${seqIndex})`
    );

    // ── 4. Run eval for the current state, then advance via CANDIDATE_RESPONSE ──
    //
    // After CANDIDATE_RESPONSE the machine may land in an intermediate state
    // (e.g. MISCONCEPTION_DETECT, CONFIDENCE_CALIBRATE) that is NOT a stable
    // resting point — it needs eval dispatched and possibly further advances
    // before control should return to the WS layer.
    //
    // pumpToRest() drives the machine through all such intermediate states in
    // one turn until it reaches a CANDIDATE_AWAITING_STATES member or a
    // terminal state. This replaces the previous single-send architecture that
    // left the machine stuck in intermediate states between turns.

    logger.debug(
      { event: "eval.start", sessionId, stateName },
      `Starting eval for state ${stateName}`
    );

    await InterviewSessionController.runEval(actor, sessionId, content, ctx, stateName);

    logger.debug(
      { event: "eval.complete", sessionId, stateName },
      `Eval complete for state ${stateName}`
    );

    // ── 5. Send CANDIDATE_RESPONSE, then pump through intermediate states ──────
    await sendAndSettle(actor, { type: "CANDIDATE_RESPONSE", content }, sessionId);

    // Pump: after CANDIDATE_RESPONSE the machine may be in an intermediate state.
    // Keep running eval + advancing until we reach a resting or terminal state.
    let pumpIterations = 0;
    const MAX_PUMP_ITERATIONS = 40; // safety ceiling — no interview has >40 intermediate states

    while (true) {
      const pumpSnap     = actor.getSnapshot() as AnyMachineSnapshot;
      const pumpState    = snapToStateName(pumpSnap);
      const pumpIsTerminal = pumpSnap.status === "done" || TERMINAL_STATES.has(pumpState);
      const pumpIsResting  = CANDIDATE_AWAITING_STATES.has(pumpState);

      if (pumpIsTerminal || pumpIsResting) {
        logger.debug(
          {
            event:       "pump.stopped",
            sessionId,
            pumpState,
            pumpIterations,
            reason:      pumpIsTerminal ? "terminal" : "candidate_awaiting",
          },
          `Pump stopped at ${pumpState} after ${pumpIterations} iteration(s)`
        );
        break;
      }

      if (pumpIterations >= MAX_PUMP_ITERATIONS) {
        logger.error(
          {
            event:       "pump.max_iterations",
            sessionId,
            pumpState,
            pumpIterations,
          },
          `Pump hit MAX_PUMP_ITERATIONS (${MAX_PUMP_ITERATIONS}) at state ${pumpState} — breaking to avoid infinite loop`
        );
        break;
      }

      pumpIterations++;
      const pumpCtx = pumpSnap.context as unknown as AnyContext;

      logger.debug(
        {
          event:          "pump.iteration",
          sessionId,
          pumpState,
          pumpIterations,
          phase:          pumpCtx.phase,
        },
        `Pump iteration ${pumpIterations}: running eval for intermediate state ${pumpState}`
      );

      // Run eval for this intermediate state (dispatches the event the state needs)
      await InterviewSessionController.runEval(
        actor, sessionId, content, pumpCtx, pumpState
      );

      // After runEval the state may have already advanced (e.g. MISCONCEPTION_DETECT
      // sends PHASE_COMPLETE → moves to CONFIDENCE_CALIBRATE). Check again.
      const afterEvalSnap  = actor.getSnapshot() as AnyMachineSnapshot;
      const afterEvalState = snapToStateName(afterEvalSnap);

      if (afterEvalState === pumpState) {
        // runEval did not move the machine — state is stuck. This means the state
        // needs a CANDIDATE_RESPONSE to advance (e.g. WAR_STORY_PROBE after
        // APPLIED_QUESTION). But we already sent it — this state should be in
        // CANDIDATE_AWAITING_STATES. Log and break.
        logger.warn(
          {
            event:       "pump.no_progress",
            sessionId,
            pumpState,
            pumpIterations,
          },
          `Pump: runEval did not advance state ${pumpState} — breaking. Add to CANDIDATE_AWAITING_STATES if this state awaits candidate input.`
        );
        break;
      }
    }

    const newSnap      = actor.getSnapshot() as AnyMachineSnapshot;
    const newStateName = snapToStateName(newSnap);
    const newCtx       = newSnap.context as unknown as AnyContext;
    const isComplete   = newSnap.status === "done";

    logger.info(
      {
        event:          "candidate.response.advanced",
        sessionId,
        prevState:      stateName,
        newState:       newStateName,
        prevPhase:      ctx.phase,
        newPhase:       newCtx.phase,
        phaseChanged:   ctx.phase !== newCtx.phase,
        isComplete,
        totalExchanges: newCtx.totalExchanges,
        probeCount:     newCtx.probeCount,
        redirectCount:  newCtx.redirectCount,
        silenceEvents:  newCtx.silenceEvents,
      },
      `Machine advanced: ${stateName} → ${newStateName}`
    );

    // ── 6. Generate interviewer response ───────────────────────
    let interviewerResponse = "";

    if (!isComplete) {
      const planContext = InterviewSessionController.buildPlanContext(newCtx);
      const msgType     = InterviewSessionController.classifyMsgType(newStateName);

      logger.debug(
        {
          event:             "interviewer.response.generating",
          sessionId,
          stateName:         newStateName,
          phase:             newCtx.phase,
          transcriptLength:  transcript.length,
          planContextLength: planContext.length,
          activeProbeIndex:  newCtx.activeProbeIndex ?? 0,
          followUpIntensity: (newCtx as BehavioralMachineContext).followUpIntensity ?? "medium",
          classifiedMsgType: msgType,
        },
        "Generating interviewer response"
      );

      const aiStartMs = Date.now();

      interviewerResponse = await generateInterviewerResponse(
        {
          interviewType:     typeRegistry.get(sessionId) ?? "system_design",
          role:              newCtx.role,
          level:             newCtx.level,
          currentPhase:      newCtx.phase,
          currentState:      newStateName,
          transcript:        transcript.map((t) => ({ role: t.role, content: t.content })),
          planContext,
          activeProbeIndex:  newCtx.activeProbeIndex ?? 0,
          followUpIntensity: (newCtx as BehavioralMachineContext).followUpIntensity ?? "medium",
        },
        // Pass onChunk so Groq streams tokens directly to the caller (WS server)
        // as they arrive. generateInterviewerResponse still returns the full
        // accumulated text so transcript persistence works identically either way.
        onChunk
      );

      const aiDurationMs = Date.now() - aiStartMs;

      logger.info(
        {
          event:          "interviewer.response.generated",
          sessionId,
          stateName:      newStateName,
          phase:          newCtx.phase,
          durationMs:     aiDurationMs,
          responseLength: interviewerResponse.length,
          msgType,
          preview:        interviewerResponse.slice(0, 120),
        },
        `Interviewer response generated in ${aiDurationMs}ms (type=${msgType})`
      );

      const interviewerSeqIndex = transcript.length;
      transcript.push({
        role:      "interviewer",
        content:   interviewerResponse,
        phase:     newCtx.phase,
        stateName: newStateName,
      });

      logger.debug(
        {
          event:    "interviewer.message.persisting",
          sessionId,
          seqIndex: interviewerSeqIndex,
          msgType,
          phase:    newCtx.phase,
          stateName: newStateName,
        },
        `Persisting interviewer message (seq=${interviewerSeqIndex})`
      );

      await InterviewSessionController.persistMsg(sessionId, {
        sequenceIndex: interviewerSeqIndex,
        role:          "interviewer",
        type:          msgType,
        content:       interviewerResponse,
        phase:         newCtx.phase,
        stateName:     newStateName,
        metadata:      {},
      });

      logger.debug(
        { event: "interviewer.message.persisted", sessionId, seqIndex: interviewerSeqIndex },
        `Interviewer message persisted (seq=${interviewerSeqIndex})`
      );

    } else {
      logger.info(
        { event: "session.terminal.no_response", sessionId, stateName: newStateName },
        "Terminal state — skipping interviewer response generation"
      );
    }

    // ── 7. Persist updated session row ─────────────────────────
    logger.debug(
      {
        event:          "session.row.updating",
        sessionId,
        newPhase:       newCtx.phase,
        stateName:      newStateName,
        totalExchanges: newCtx.totalExchanges,
        silenceEvents:  newCtx.silenceEvents,
        probeCount:     newCtx.probeCount,
        redirectCount:  newCtx.redirectCount,
      },
      "Updating session row in DB"
    );

    await db
      .update(interviewSessions)
      .set({
        currentPhase:         newCtx.phase,
        stateMachineSnapshot: newSnap as unknown as typeof interviewSessions.$inferInsert["stateMachineSnapshot"],
        metadata: {
          durationSeconds: 0,
          totalExchanges:  newCtx.totalExchanges,
          silenceEvents:   newCtx.silenceEvents,
          probeCount:      newCtx.probeCount,
          redirectCount:   newCtx.redirectCount,
        },
        updatedAt: new Date(),
      })
      .where(eq(interviewSessions.id, sessionId));

    logger.debug(
      { event: "session.row.updated", sessionId },
      "Session row updated in DB"
    );

    // ── 8. Finalize if terminal ────────────────────────────────
    if (isComplete && newStateName === "TERMINAL_COMPLETED") {
      logger.info(
        { event: "session.finalize.trigger", sessionId, stateName: newStateName },
        "TERMINAL_COMPLETED reached — triggering finalization"
      );
      await InterviewSessionController.finalize(sessionId, actor, userId);
    } else if (isComplete) {
      // Machine is done but not via TERMINAL_COMPLETED — flag for investigation.
      logger.warn(
        {
          event:         "session.terminal.unexpected",
          sessionId,
          stateName:     newStateName,
          machineStatus: newSnap.status,
        },
        `Machine reached done status via unexpected state: ${newStateName}`
      );
    }

    transcriptRegistry.set(sessionId, transcript);

    logger.debug(
      {
        event:            "candidate.response.handled",
        sessionId,
        newState:         newStateName,
        newPhase:         newCtx.phase,
        isComplete,
        transcriptLength: transcript.length,
      },
      "handleCandidateResponse complete"
    );

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

      // ── System Design ──────────────────────────────────────────────────────

      if (stateName === "FIRST_MOVE_DETECT") {
        logger.debug(
          { event: "eval.first_move.start", sessionId, contentLength: content.length },
          "Detecting first move"
        );
        const startMs   = Date.now();
        const move      = await detectFirstMove(content);
        const eventType = move === "CLARIFY" ? "FIRST_MOVE_CLARIFY" : "FIRST_MOVE_JUMP";
        logger.info(
          {
            event:      "eval.first_move.result",
            sessionId,
            move,
            eventType,
            durationMs: Date.now() - startMs,
          },
          `First move: ${move} → dispatching ${eventType}`
        );
        await sendAndSettle(actor, { type: eventType }, sessionId);
        return;
      }

      // ── Behavioral ─────────────────────────────────────────────────────────

      if (stateName === "STORY_EXISTENCE_CHECK") {
        logger.debug(
          { event: "eval.story_existence.start", sessionId },
          "Checking story existence"
        );
        const startMs = Date.now();
        const exists  = await detectStoryExistence(content);
        logger.info(
          {
            event:      "eval.story_existence.result",
            sessionId,
            exists,
            durationMs: Date.now() - startMs,
          },
          `Story existence: ${exists}`
        );
        await sendAndSettle(actor, { type: "STORY_EXISTS", exists }, sessionId);
        return;
      }

      if (stateName === "STAR_PARSING_LIVE_1") {
        const bCtx    = ctx as BehavioralMachineContext;
        const planItem: CompetencyPlan | undefined =
          bCtx.competencyPlan[bCtx.currentCompetencyIndex];

        logger.debug(
          {
            event:                  "eval.star_parse.start",
            sessionId,
            currentCompetencyIndex: bCtx.currentCompetencyIndex,
            totalCompetencies:      bCtx.competencyPlan.length,
            competency:             planItem?.competency ?? null,
            hasPlanItem:            !!planItem,
          },
          `STAR parsing (competency index ${bCtx.currentCompetencyIndex}/${bCtx.competencyPlan.length})`
        );

        if (planItem) {
          const startMs   = Date.now();
          const parsed    = await parseStarComponents(planItem.competency, content);
          const resultScore = typeof parsed.result === "number" ? parsed.result : 0;
          const outcome     = resultScore < 0.4 ? "RESULT_WEAK" : "PHASE_COMPLETE";

          logger.info(
            {
              event:       "eval.star_parse.result",
              sessionId,
              competency:  planItem.competency,
              durationMs:  Date.now() - startMs,
              resultScore,
              outcome,
              components: {
                situation: parsed.situation,
                task:      parsed.task,
                action:    parsed.action,
                result:    parsed.result,
              },
            },
            `STAR parse: resultScore=${resultScore.toFixed(2)} → ${outcome}`
          );

          await sendAndSettle(actor, { type: "STAR_PARSED", partial: parsed }, sessionId);
          await sendAndSettle(actor, { type: outcome }, sessionId);
        } else {
          logger.warn(
            {
              event:                  "eval.star_parse.no_plan_item",
              sessionId,
              currentCompetencyIndex: bCtx.currentCompetencyIndex,
              planLength:             bCtx.competencyPlan.length,
            },
            "No competency plan item at current index — sending PHASE_COMPLETE"
          );
          await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        }
        return;
      }

      if (stateName === "ATTRIBUTION_CHECK") {
        logger.debug(
          { event: "eval.attribution.start", sessionId },
          "Running attribution flag detection"
        );
        const startMs            = Date.now();
        const { hasFlag, ratio } = await detectAttributionFlag(content);
        logger.info(
          {
            event:      "eval.attribution.result",
            sessionId,
            hasFlag,
            ratio,
            durationMs: Date.now() - startMs,
          },
          `Attribution: hasFlag=${hasFlag}, ratio=${ratio.toFixed(3)}`
        );
        await sendAndSettle(
          actor,
          { type: "ATTRIBUTION_CHECK_COMPLETE", hasFlag, ratio },
          sessionId
        );
        return;
      }

      // ── Domain Knowledge ───────────────────────────────────────────────────

      if (stateName === "MISCONCEPTION_DETECT") {
        const dCtx       = ctx as DomainKnowledgeMachineContext;
        const domainItem: DomainPlan | undefined = dCtx.domainPlan[dCtx.currentDomain];

        logger.debug(
          {
            event:         "eval.misconception.start",
            sessionId,
            currentDomain: dCtx.currentDomain,
            totalDomains:  dCtx.domainPlan.length,
            domain:        domainItem?.domain ?? null,
            hasDomainItem: !!domainItem,
          },
          `Detecting misconceptions (domain index ${dCtx.currentDomain}/${dCtx.domainPlan.length})`
        );

        if (domainItem) {
          const startMs        = Date.now();
          const misconceptions = await detectMisconceptions(domainItem.domain, content, []);
          logger.info(
            {
              event:              "eval.misconception.result",
              sessionId,
              domain:             domainItem.domain,
              durationMs:         Date.now() - startMs,
              misconceptionCount: misconceptions.length,
              misconceptions,
            },
            `Misconception detection: ${misconceptions.length} found`
          );

          for (const [i, m] of misconceptions.entries()) {
            logger.debug(
              {
                event:         "eval.misconception.dispatching",
                sessionId,
                index:         i,
                total:         misconceptions.length,
                misconception: m,
              },
              `Dispatching MISCONCEPTION_DETECTED (${i + 1}/${misconceptions.length})`
            );
            await sendAndSettle(
              actor,
              { type: "MISCONCEPTION_DETECTED", misconception: m },
              sessionId
            );
          }
        } else {
          logger.warn(
            {
              event:         "eval.misconception.no_domain_item",
              sessionId,
              currentDomain: dCtx.currentDomain,
              planLength:    dCtx.domainPlan.length,
            },
            "No domain item at currentDomain index — skipping detection"
          );
        }

        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "CONFIDENCE_CALIBRATE") {
        logger.debug(
          { event: "eval.confidence.start", sessionId },
          "Assessing confidence calibration"
        );
        const startMs                      = Date.now();
        const { overconfident, underconfident } = await assessConfidence(content);
        logger.info(
          {
            event:          "eval.confidence.result",
            sessionId,
            overconfident,
            underconfident,
            durationMs:     Date.now() - startMs,
          },
          `Confidence: over=${overconfident}, under=${underconfident}`
        );
        await sendAndSettle(
          actor,
          { type: "CONFIDENCE_ASSESSED", overconfident, underconfident },
          sessionId
        );
        return;
      }

      if (stateName === "TUTORIAL_VS_PROD_CLASSIFY") {
        logger.debug(
          { event: "eval.prod_depth.start", sessionId },
          "Classifying production depth"
        );
        const startMs              = Date.now();
        const { depth, inflation } = await classifyProductionDepth(content);
        logger.info(
          {
            event:      "eval.prod_depth.result",
            sessionId,
            depth,
            inflation,
            durationMs: Date.now() - startMs,
          },
          `Production depth: depth=${depth}, inflation=${inflation}`
        );
        await sendAndSettle(
          actor,
          { type: "TUTORIAL_OR_PROD_CLASSIFIED", depth, inflation },
          sessionId
        );
        return;
      }

      if (stateName === "RESPONSE_CLASSIFY") {
        // Advance to REASONING_DEPTH_EVAL. Coachability scoring happens
        // synchronously in the COACHABILITY_SCORING handler below — NOT here.
        // The previous setImmediate pattern sent COACHABILITY_SCORED after the
        // machine had already moved past COACHABILITY_SCORING, silently dropping it.
        logger.debug(
          { event: "eval.response_classify.advance", sessionId },
          "RESPONSE_CLASSIFY: advancing to REASONING_DEPTH_EVAL"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      // ── Domain Knowledge — auto-advance states ───────────────────────────────

      if (stateName === "COACHABILITY_SCORING") {
        // P0 FIX: No handler existed. The async setImmediate in RESPONSE_CLASSIFY
        // sent COACHABILITY_SCORED after the machine had already advanced, where
        // it was silently dropped. Score synchronously here, in the correct state.
        const localTranscript = transcriptRegistry.get(sessionId) ?? [];
        const lastInterviewer = [...localTranscript].reverse().find((m) => m.role === "interviewer");
        const challenge = lastInterviewer?.content ?? "";
        logger.debug(
          { event: "eval.coachability.start", sessionId, challengeLength: challenge.length },
          "COACHABILITY_SCORING: scoring synchronously"
        );
        const startMs = Date.now();
        const score = await scoreCoachability(challenge, content);
        logger.info(
          { event: "eval.coachability.result", sessionId, score, durationMs: Date.now() - startMs },
          `Coachability score: ${score.toFixed(3)}`
        );
        await sendAndSettle(actor, { type: "COACHABILITY_SCORED", score }, sessionId);
        return;
      }

      if (stateName === "CROSS_DOMAIN_LINK") {
        // P0 FIX: After D2_FLOWING_CONVO CANDIDATE_RESPONSE the machine enters
        // CROSS_DOMAIN_LINK. No handler existed — pump broke immediately, leaving
        // the interview permanently stuck in DK Phase 4.
        logger.debug(
          { event: "eval.cross_domain_link.advance", sessionId },
          "CROSS_DOMAIN_LINK: advancing to D2_PACING"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "D2_PACING") {
        // P0 FIX: Advance back to D2_FLOWING_CONVO for the next D2 question.
        logger.debug(
          { event: "eval.d2_pacing.advance", sessionId },
          "D2_PACING: advancing to D2_FLOWING_CONVO"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "D2_REDIRECT") {
        // P0 FIX: issueD2Redirect action already fired on entry. Resume D2.
        logger.debug(
          { event: "eval.d2_redirect.advance", sessionId },
          "D2_REDIRECT: advancing back to D2_FLOWING_CONVO"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "PROD_SIGNAL_DETECT") {
        // After APPLIED_QUESTION CANDIDATE_RESPONSE → PROD_SIGNAL_DETECT.
        // Machine immediately transitions to WAR_STORY_PROBE on PHASE_COMPLETE.
        logger.debug(
          { event: "eval.prod_signal_detect.advance", sessionId },
          "PROD_SIGNAL_DETECT: auto-advancing to WAR_STORY_PROBE"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "MISCONCEPTION_RESOLUTION") {
        // After EDGE_CASE_QUESTION CANDIDATE_RESPONSE → MISCONCEPTION_RESOLUTION.
        // Confronts deferred misconceptions from Phase 1; controller has already
        // accumulated them via MISCONCEPTION_DETECTED events during MISCONCEPTION_DETECT.
        // Advance to IDK_HANDLING.
        logger.debug(
          { event: "eval.misconception_resolution.advance", sessionId },
          "MISCONCEPTION_RESOLUTION: auto-advancing to IDK_HANDLING"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "IDK_HANDLING") {
        // Candidate didn't explicitly say "I don't know" — send PHASE_COMPLETE
        // to advance to ADJACENT_DOMAIN_TEST.
        logger.debug(
          { event: "eval.idk_handling.advance", sessionId },
          "IDK_HANDLING: no IDK detected — auto-advancing to ADJACENT_DOMAIN_TEST"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "REASONING_DEPTH_EVAL") {
        // After RESPONSE_CLASSIFY PHASE_COMPLETE → REASONING_DEPTH_EVAL.
        // Advance to COACHABILITY_SCORING.
        logger.debug(
          { event: "eval.reasoning_depth.advance", sessionId },
          "REASONING_DEPTH_EVAL: auto-advancing to COACHABILITY_SCORING"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "CLAIM_VALIDATION") {
        // CLAIM_VALIDATION accumulates CLAIM_VALIDATED events then waits for
        // PHASE_COMPLETE. The controller has no claim validation AI call, so
        // we advance immediately. Add claim validation AI here when available.
        logger.debug(
          { event: "eval.claim_validation.advance", sessionId },
          "CLAIM_VALIDATION: auto-advancing to EDGE_CASE_QUESTION"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "CLAIM_VALIDATION_MAP") {
        // Internal post-scoring state — advance to DEPTH_PROFILE_GEN.
        logger.debug(
          { event: "eval.claim_validation_map.advance", sessionId },
          "CLAIM_VALIDATION_MAP: auto-advancing to DEPTH_PROFILE_GEN"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "DEPTH_PROFILE_GEN") {
        // Internal post-scoring state — advance to HIRE_SIGNAL_CALC.
        logger.debug(
          { event: "eval.depth_profile_gen.advance", sessionId },
          "DEPTH_PROFILE_GEN: auto-advancing to HIRE_SIGNAL_CALC"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      // ── Domain Knowledge — scored states ───────────────────────────────────────
      //
      // These states wait for a specific scored event. The controller calls
      // evaluateAnswer() (ai-engine) to produce the score, then dispatches it.
      // Previously these states had no handler — machine blocked forever.

      if (stateName === "CONCEPTUAL_SCORING") {
        // Score the conceptual answer using the domain plan's first domain.
        const dCtx = ctx as DomainKnowledgeMachineContext;
        const domainItem = dCtx.domainPlan[dCtx.currentDomain];
        logger.debug(
          {
            event:         "eval.conceptual_scoring.start",
            sessionId,
            currentDomain: dCtx.currentDomain,
            domain:        domainItem?.domain ?? null,
          },
          "Scoring conceptual answer"
        );
        const startMs = Date.now();
        // Use overall transcript quality as a proxy score until a dedicated
        // conceptual scorer is wired into the ai-engine.
        // Score heuristic: misconceptions detected reduce score; clean answer scores high.
        const misconceptionPenalty = Math.min(0.3, dCtx.misconceptionsDetected.length * 0.1);
        const confidencePenalty    = dCtx.overconfidenceFlag ? 0.1 : 0;
        const score                = Math.max(0, 0.8 - misconceptionPenalty - confidencePenalty);
        logger.info(
          {
            event:              "eval.conceptual_scoring.result",
            sessionId,
            score,
            durationMs:         Date.now() - startMs,
            misconceptionCount: dCtx.misconceptionsDetected.length,
            overconfidence:     dCtx.overconfidenceFlag,
          },
          `Conceptual score: ${score.toFixed(2)}`
        );
        await sendAndSettle(actor, { type: "CONCEPTUAL_SCORED", score }, sessionId);
        return;
      }

      if (stateName === "DEPTH_SCORING") {
        // Score the edge-case / depth answer.
        const dCtx = ctx as DomainKnowledgeMachineContext;
        logger.debug(
          {
            event:            "eval.depth_scoring.start",
            sessionId,
            productionDepth:  dCtx.productionDepthScore,
            inflationFlag:    dCtx.inflationFlag,
            idkHandled:       dCtx.idkHandled,
          },
          "Scoring depth answer"
        );
        const startMs = Date.now();
        // Heuristic: production depth score is the primary signal.
        // Adjacent domain tested and IDK handled add small bonuses.
        const base   = dCtx.productionDepthScore;
        const bonus  = (dCtx.adjacentDomainTested ? 0.05 : 0) + (dCtx.idkHandled ? 0.05 : 0);
        const score  = Math.min(1, base + bonus);
        logger.info(
          {
            event:      "eval.depth_scoring.result",
            sessionId,
            score,
            durationMs: Date.now() - startMs,
          },
          `Depth score: ${score.toFixed(2)}`
        );
        await sendAndSettle(actor, { type: "DEPTH_SCORED", score }, sessionId);
        return;
      }

      if (stateName === "D2_SCORING") {
        // Score the domain 2 conversation.
        const dCtx = ctx as DomainKnowledgeMachineContext;
        logger.debug(
          {
            event:            "eval.d2_scoring.start",
            sessionId,
            crossDomainLinked: dCtx.crossDomainLinked,
            d2RedirectIssued: dCtx.d2RedirectIssued,
          },
          "Scoring domain 2 answer"
        );
        const startMs   = Date.now();
        const base      = dCtx.crossDomainLinked ? 0.75 : 0.5;
        const penalty   = dCtx.d2RedirectIssued ? 0.1 : 0;
        const score     = Math.min(1, Math.max(0, base - penalty));
        const depthType = dCtx.crossDomainLinked ? ("deep" as const) : ("broad" as const);
        logger.info(
          {
            event:      "eval.d2_scoring.result",
            sessionId,
            score,
            depthType,
            durationMs: Date.now() - startMs,
          },
          `D2 score: ${score.toFixed(2)} (${depthType})`
        );
        await sendAndSettle(
          actor,
          { type: "D2_SCORED", score, depthType },
          sessionId
        );
        return;
      }

      if (stateName === "STRETCH_SCORING") {
        // Score the stretch / domain 3 answer.
        const dCtx = ctx as DomainKnowledgeMachineContext;
        logger.debug(
          { event: "eval.stretch_scoring.start", sessionId },
          "Scoring stretch answer"
        );
        const startMs      = Date.now();
        // Heuristic proxy until a dedicated stretch scorer exists.
        const firstPrinciples = Math.min(1, dCtx.productionDepthScore + 0.1);
        const learning        = dCtx.coachabilityScore;
        logger.info(
          {
            event:         "eval.stretch_scoring.result",
            sessionId,
            firstPrinciples,
            learning,
            durationMs:    Date.now() - startMs,
          },
          `Stretch: firstPrinciples=${firstPrinciples.toFixed(2)}, learning=${learning.toFixed(2)}`
        );
        await sendAndSettle(
          actor,
          { type: "STRETCH_SCORED", firstPrinciples, learning },
          sessionId
        );
        return;
      }

      // ── Domain Knowledge — terminal pipeline ─────────────────────────────────
      //
      // DOMAIN_SCORE_CALC and REPORT_BUILDING are the machine's terminal scoring
      // states. Previously finalize() was intended to handle these, but finalize()
      // is only called after `newSnap.status === "done"` — which can never be
      // reached because the machine blocks in DOMAIN_SCORE_CALC waiting for
      // SCORE_COMPUTED. These states must be driven here, in runEval, so the
      // machine can reach TERMINAL_COMPLETED and trigger finalize() normally.

      if (stateName === "DOMAIN_SCORE_CALC") {
        const dCtx     = ctx as DomainKnowledgeMachineContext;
        const transcript = transcriptRegistry.get(sessionId) ?? [];
        const session    = await db.query.interviewSessions.findFirst({
          where:   eq(interviewSessions.id, sessionId),
          columns: { type: true, tier: true },
        });
        if (!session) {
          logger.error(
            { event: "eval.domain_score_calc.no_session", sessionId },
            "Session not found during DOMAIN_SCORE_CALC — cannot score"
          );
          return;
        }
        logger.info(
          {
            event:           "eval.domain_score_calc.start",
            sessionId,
            transcriptLength: transcript.length,
          },
          "Computing dimension scores from DOMAIN_SCORE_CALC state"
        );
        const startMs = Date.now();
        const plan    = dCtx.domainPlan;
        const scoringTranscript = transcript.map((t) => ({
          role:      t.role,
          content:   t.content,
          phase:     t.phase,
          stateName: t.stateName,
        }));
        const { scores, overall, hireSignal } = await computeDimensionScores(
          session!.type,
          scoringTranscript,
          plan,
          session!.tier
        );
        logger.info(
          {
            event:          "eval.domain_score_calc.result",
            sessionId,
            durationMs:     Date.now() - startMs,
            dimensionCount: scores.length,
            overall,
            hireSignal,
          },
          `Dimension scores computed: overall=${overall.toFixed(3)}, signal=${hireSignal}`
        );
        await sendAndSettle(
          actor,
          { type: "SCORE_COMPUTED", scores, overall },
          sessionId
        );
        return;
      }

      if (stateName === "REPORT_BUILDING") {
        const dCtx     = ctx as DomainKnowledgeMachineContext;
        const transcript = transcriptRegistry.get(sessionId) ?? [];
        const session    = await db.query.interviewSessions.findFirst({
          where:   eq(interviewSessions.id, sessionId),
          columns: { type: true, tier: true },
        });
        if (!session) {
          logger.error(
            { event: "eval.report_building.no_session", sessionId },
            "Session not found during REPORT_BUILDING — cannot generate report"
          );
          return;
        }
        logger.info(
          { event: "eval.report_building.start", sessionId },
          "Generating report from REPORT_BUILDING state"
        );
        const startMs = Date.now();
        const scoringTranscript = transcript.map((t) => ({
          role:      t.role,
          content:   t.content,
          phase:     t.phase,
          stateName: t.stateName,
        }));
        const report = await generateReport(
          session!.type,
          sessionId,
          dCtx.dimensionScores,
          dCtx.overallScore ?? 0,
          dCtx.hireSignal ?? "no_hire",
          scoringTranscript,
          session!.tier
        );
        logger.info(
          {
            event:      "eval.report_building.result",
            sessionId,
            durationMs: Date.now() - startMs,
          },
          "Report generated — dispatching REPORT_READY"
        );
        await sendAndSettle(actor, { type: "REPORT_READY", report }, sessionId);
        return;
      }

      // ══════════════════════════════════════════════════════════════════════
      // SYSTEM DESIGN — eval branches (document 8)
      // ══════════════════════════════════════════════════════════════════════

      // ── Auto-advance states: no AI work, just PHASE_COMPLETE ───────────────

      if (stateName === "CLARIFY_STARTED" || stateName === "SOLUTION_JUMPED") {
        // After FIRST_MOVE_CLARIFY/JUMP the machine lands here.
        // Both states advance to CLARIFYING on PHASE_COMPLETE.
        logger.debug(
          { event: "eval.sd.clarify_advance", sessionId, stateName },
          `${stateName}: auto-advancing to CLARIFYING`
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "NFR_NUDGE_CHECK") {
        // After CLARIFYING CANDIDATE_RESPONSE → NFR_NUDGE_CHECK.
        // Advance to SCORING_COVERAGE.
        logger.debug(
          { event: "eval.sd.nfr_nudge.advance", sessionId },
          "NFR_NUDGE_CHECK: auto-advancing to SCORING_COVERAGE"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "MATH_VALIDATION") {
        // After ESTIMATING CANDIDATE_RESPONSE → MATH_VALIDATION.
        // Advance to SCAFFOLDING_CHECK.
        logger.debug(
          { event: "eval.sd.math_validation.advance", sessionId },
          "MATH_VALIDATION: auto-advancing to SCAFFOLDING_CHECK"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "GAP_DETECTION") {
        // After HLD_LISTENING CANDIDATE_RESPONSE → GAP_DETECTION.
        // PHASE_COMPLETE transitions to PROBE_ISSUE if probesBudgetRemaining,
        // otherwise to SCORING_COMPONENT_COVERAGE. The guard is evaluated by
        // the machine — controller just sends PHASE_COMPLETE.
        logger.debug(
          { event: "eval.sd.gap_detection.advance", sessionId },
          "GAP_DETECTION: auto-advancing (machine guard selects PROBE_ISSUE or SCORING)"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "WEAK_POINT_SELECT") {
        // Advance to TRADEOFF_CHALLENGE.
        logger.debug(
          { event: "eval.sd.weak_point.advance", sessionId },
          "WEAK_POINT_SELECT: auto-advancing to TRADEOFF_CHALLENGE"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "ADAPTATION_SCORING") {
        // After SCALE_STRESS_TEST CANDIDATE_RESPONSE → ADAPTATION_SCORING.
        // Advance to SELF_CRITIQUE_PROMPT.
        logger.debug(
          { event: "eval.sd.adaptation_scoring.advance", sessionId },
          "ADAPTATION_SCORING: auto-advancing to SELF_CRITIQUE_PROMPT"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "SELF_AWARENESS_SCORE") {
        // After SELF_CRITIQUE_PROMPT CANDIDATE_RESPONSE → SELF_AWARENESS_SCORE.
        // Advance to CANDIDATE_QA with a neutral selfAwarenessScore.
        // Replace with AI evaluation when a self-awareness scorer is available.
        logger.debug(
          { event: "eval.sd.self_awareness.advance", sessionId },
          "SELF_AWARENESS_SCORE: auto-advancing to CANDIDATE_QA"
        );
        await sendAndSettle(
          actor,
          { type: "PHASE_COMPLETE", selfAwarenessScore: 0.5 as 0 | 0.5 | 1 },
          sessionId
        );
        return;
      }

      if (stateName === "SESSION_CLOSING") {
        // Advance to DIMENSION_SCORING.
        logger.debug(
          { event: "eval.sd.session_closing.advance", sessionId },
          "SESSION_CLOSING: auto-advancing to DIMENSION_SCORING"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "EVIDENCE_MAPPING") {
        // Advance to HIRE_SIGNAL_CALC.
        logger.debug(
          { event: "eval.sd.evidence_mapping.advance", sessionId },
          "EVIDENCE_MAPPING: auto-advancing to HIRE_SIGNAL_CALC"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      // ── REQUIREMENT_CONFIRM: needs CANDIDATE_READY (not CANDIDATE_RESPONSE) ──
      // This state transitions to ESTIMATING on CANDIDATE_READY, not CANDIDATE_RESPONSE.
      // The controller's handleCandidateResponse sends CANDIDATE_RESPONSE after runEval,
      // which would be dropped. Instead we send CANDIDATE_READY here and return early
      // so the caller does not send an additional CANDIDATE_RESPONSE.
      if (stateName === "REQUIREMENT_CONFIRM") {
        logger.debug(
          { event: "eval.sd.requirement_confirm.advance", sessionId },
          "REQUIREMENT_CONFIRM: sending CANDIDATE_READY to advance to ESTIMATING"
        );
        await sendAndSettle(actor, { type: "CANDIDATE_READY" }, sessionId);
        return;
      }

      // ── TRADEOFF_CHALLENGE / FAILURE_MODE_PROBE: need TRADEOFF_RESPONSE ──────
      // These states only accept TRADEOFF_RESPONSE (not CANDIDATE_RESPONSE).
      // The controller's normal flow sends CANDIDATE_RESPONSE after runEval,
      // which would be silently dropped. We send TRADEOFF_RESPONSE here with a
      // heuristic increment, then return so no CANDIDATE_RESPONSE is sent.
      if (stateName === "TRADEOFF_CHALLENGE" || stateName === "FAILURE_MODE_PROBE") {
        const sdCtx = ctx as SystemDesignMachineContext;
        // Heuristic tradeoff increment — replace with dedicated AI scorer when available.
        const tradeoffIncrement = content.length > 200 ? 0.2 : 0.1;
        logger.debug(
          {
            event:              "eval.sd.tradeoff.advance",
            sessionId,
            stateName,
            tradeoffIncrement,
            currentTradeoff:    sdCtx.tradeoffScore,
          },
          `${stateName}: sending TRADEOFF_RESPONSE (increment=${tradeoffIncrement})`
        );
        // TRADEOFF_RESPONSE requires a response field matching CandidateResponse shape.
        // We pass a minimal object; full CandidateResponse typing is enforced by the machine.
        await sendAndSettle(
          actor,
          {
            type: "TRADEOFF_RESPONSE",
            response:          { content } as unknown as import("@interview/shared-types").CandidateResponse,
            tradeoffIncrement,
          },
          sessionId
        );
        return;
      }

      // ── PROBE_RESPONSE_EVAL: needs PROBE_EVALUATED ────────────────────────────
      if (stateName === "PROBE_RESPONSE_EVAL") {
        // Heuristic probe evaluation — replace with AI scorer when available.
        const responseType = content.length > 150 ? "acknowledged_explained" as const
                           : content.length > 50  ? "partial" as const
                           : "defensive" as const;
        const score = responseType === "acknowledged_explained" ? 0.8
                    : responseType === "partial"                ? 0.5 : 0.2;
        logger.debug(
          {
            event:        "eval.sd.probe_eval.advance",
            sessionId,
            responseType,
            score,
          },
          `PROBE_RESPONSE_EVAL: dispatching PROBE_EVALUATED (${responseType}, score=${score})`
        );
        await sendAndSettle(
          actor,
          { type: "PROBE_EVALUATED", response: responseType, score },
          sessionId
        );
        return;
      }

      // ── Scored states: compute and dispatch ──────────────────────────────────

      if (stateName === "SCORING_COVERAGE") {
        // Heuristic requirement coverage score — replace with AI scorer when available.
        const score = Math.min(1, content.length / 800);
        logger.debug(
          { event: "eval.sd.coverage_scored.dispatch", sessionId, score },
          `SCORING_COVERAGE: dispatching COVERAGE_SCORED (score=${score.toFixed(2)})`
        );
        await sendAndSettle(actor, { type: "COVERAGE_SCORED", score }, sessionId);
        return;
      }

      if (stateName === "SCORING_ESTIMATION") {
        // Heuristic estimation score — replace with AI scorer when available.
        const score = Math.min(1, content.length / 600);
        const hintIssued = false;
        logger.debug(
          { event: "eval.sd.estimation_scored.dispatch", sessionId, score },
          `SCORING_ESTIMATION: dispatching ESTIMATION_SCORED (score=${score.toFixed(2)})`
        );
        await sendAndSettle(
          actor,
          { type: "ESTIMATION_SCORED", score, hintIssued },
          sessionId
        );
        return;
      }

      if (stateName === "SCORING_COMPONENT_COVERAGE") {
        // Heuristic component coverage — replace with AI scorer when available.
        const coverage = Math.min(1, content.length / 700);
        logger.debug(
          { event: "eval.sd.component_coverage.dispatch", sessionId, coverage },
          `SCORING_COMPONENT_COVERAGE: dispatching COMPONENT_COVERAGE_SCORED (coverage=${coverage.toFixed(2)})`
        );
        await sendAndSettle(
          actor,
          { type: "COMPONENT_COVERAGE_SCORED", coverage },
          sessionId
        );
        return;
      }

      if (stateName === "DIMENSION_SCORING") {
        // Compute full dimension scores and dispatch SCORE_COMPUTED.
        const sdCtx    = ctx as SystemDesignMachineContext;
        const transcript = transcriptRegistry.get(sessionId) ?? [];
        const session    = await db.query.interviewSessions.findFirst({
          where:   eq(interviewSessions.id, sessionId),
          columns: { type: true, tier: true },
        });
        if (!session) {
          logger.error({ event: "eval.sd.dimension_scoring.no_session", sessionId }, "Session not found");
          return;
        }
        logger.info(
          { event: "eval.sd.dimension_scoring.start", sessionId, transcriptLength: transcript.length },
          "Computing SD dimension scores"
        );
        const startMs = Date.now();
        const plan = sdCtx.interviewObject ?? [];
        const scoringTranscript = transcript.map((t) => ({
          role: t.role, content: t.content, phase: t.phase, stateName: t.stateName,
        }));
        const { scores, overall } = await computeDimensionScores(
          session!.type, scoringTranscript, plan as never, session!.tier
        );
        logger.info(
          { event: "eval.sd.dimension_scoring.result", sessionId, durationMs: Date.now() - startMs, overall },
          `SD scores computed: overall=${overall.toFixed(3)}`
        );
        await sendAndSettle(actor, { type: "SCORE_COMPUTED", scores, overall }, sessionId);
        return;
      }

      if (stateName === "HIRE_SIGNAL_CALC" && typeRegistry.get(sessionId) === "system_design") {
        // SD HIRE_SIGNAL_CALC advances on PHASE_COMPLETE (not SCORE_COMPUTED).
        logger.debug(
          { event: "eval.sd.hire_signal.advance", sessionId },
          "SD HIRE_SIGNAL_CALC: advancing to REPORT_GENERATED"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "HIRE_SIGNAL_CALC" && typeRegistry.get(sessionId) === "domain_knowledge") {
        // P0 FIX: DK HIRE_SIGNAL_CALC was missing entirely.
        // computeHireSignal action already fired on state entry — just advance.
        logger.debug(
          { event: "eval.dk.hire_signal.advance", sessionId },
          "DK HIRE_SIGNAL_CALC: advancing to REPORT_BUILDING"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "REPORT_GENERATED") {
        // SD uses event type "REPORT_GENERATED" (not "REPORT_READY") and action applyReport.
        // The event payload must have a `report` field.
        const sdCtx    = ctx as SystemDesignMachineContext;
        const transcript = transcriptRegistry.get(sessionId) ?? [];
        const session    = await db.query.interviewSessions.findFirst({
          where:   eq(interviewSessions.id, sessionId),
          columns: { type: true, tier: true },
        });
        if (!session) {
          logger.error({ event: "eval.sd.report.no_session", sessionId }, "Session not found");
          return;
        }
        logger.info({ event: "eval.sd.report.start", sessionId }, "Generating SD report");
        const startMs = Date.now();
        const scoringTranscript = transcript.map((t) => ({
          role: t.role, content: t.content, phase: t.phase, stateName: t.stateName,
        }));
        const report = await generateReport(
          session!.type, sessionId,
          sdCtx.dimensionScores, sdCtx.overallScore ?? 0,
          sdCtx.hireSignal ?? "no_hire",
          scoringTranscript, session!.tier
        );
        logger.info(
          { event: "eval.sd.report.result", sessionId, durationMs: Date.now() - startMs },
          "SD report generated"
        );
        // Note: event type must be "REPORT_GENERATED" — matches the machine's on: { REPORT_GENERATED: ... }
        await sendAndSettle(actor, { type: "REPORT_GENERATED", report } as never, sessionId);
        return;
      }

      // ══════════════════════════════════════════════════════════════════════
      // BEHAVIORAL — eval branches (document 7)
      // ══════════════════════════════════════════════════════════════════════

      // ── Auto-advance states ────────────────────────────────────────────────

      if (stateName === "STRUCTURE_DETECT") {
        logger.debug({ event: "eval.beh.structure_detect.advance", sessionId }, "STRUCTURE_DETECT: auto-advancing to ATTRIBUTION_CHECK");
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "FALLBACK_PROMPT") {
        // Resting state — machine waits for CANDIDATE_RESPONSE unless the
        // always: guard (fallbackAlsoFailed) fires synchronously on entry and
        // self-transitions to ADVERSITY_SCORING. Either way, pumpToRest stops
        // here (it's in CANDIDATE_AWAITING_STATES) and we return immediately.
        logger.debug(
          { event: "eval.beh.fallback_prompt.passthrough", sessionId },
          "FALLBACK_PROMPT: resting, waiting for candidate response"
        );
        return;
      }

      if (stateName === "SCOPE_VALIDATION_1") {
        logger.debug({ event: "eval.beh.scope_validation.advance", sessionId }, "SCOPE_VALIDATION_1: auto-advancing to ADVERSITY_QUESTION");
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "NEG_LANGUAGE_DETECT") {
        logger.debug({ event: "eval.beh.neg_language.advance", sessionId }, "NEG_LANGUAGE_DETECT: auto-advancing to ACCOUNTABILITY_PROBE");
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "SCOPE_LADDER_CLASSIFY") {
        logger.debug({ event: "eval.beh.scope_ladder.advance", sessionId }, "SCOPE_LADDER_CLASSIFY: auto-advancing to STAKEHOLDER_PROBE");
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "STORY_OVERLAP_CHECK") {
        logger.debug({ event: "eval.beh.story_overlap.advance", sessionId }, "STORY_OVERLAP_CHECK: auto-advancing to DETAIL_CONSISTENCY");
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "DETAIL_CONSISTENCY") {
        logger.debug({ event: "eval.beh.detail_consistency.advance", sessionId }, "DETAIL_CONSISTENCY: auto-advancing to SPECIFICITY_TEST");
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "SPECIFICITY_TEST") {
        logger.debug({ event: "eval.beh.specificity_test.advance", sessionId }, "SPECIFICITY_TEST: auto-advancing to AUTHENTICITY_FLAGS");
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "PER_COMPETENCY_SCORE") {
        logger.debug({ event: "eval.beh.per_competency_score.advance", sessionId }, "PER_COMPETENCY_SCORE: auto-advancing to STAR_L_COVERAGE");
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "STAR_L_COVERAGE") {
        logger.debug({ event: "eval.beh.star_l_coverage.advance", sessionId }, "STAR_L_COVERAGE: auto-advancing to HIRE_SIGNAL_CALC");
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      // ── FOLLOW_UP_PROBING_1: accepts PROBE_RESPONSE not CANDIDATE_RESPONSE ──
      // The machine only has on: { PROBE_RESPONSE: [...] }. The controller's
      // normal post-runEval CANDIDATE_RESPONSE send would be dropped. We send
      // PROBE_RESPONSE here and return early to prevent that.
      if (stateName === "FOLLOW_UP_PROBING_1") {
        logger.debug(
          { event: "eval.beh.follow_up_probing.advance", sessionId },
          "FOLLOW_UP_PROBING_1: sending PROBE_RESPONSE (machine guards select next state)"
        );
        await sendAndSettle(actor, { type: "PROBE_RESPONSE" }, sessionId);
        return;
      }

      // ── Scored states ──────────────────────────────────────────────────────

      if (stateName === "BASELINE_QUESTION") {
        // BASELINE_QUESTION transitions on BASELINE_SCORED or TIMEOUT.
        // No dedicated baseline scorer exists in the ai-engine yet.
        // Heuristic: use answer length and structure as proxy.
        const wordCount = content.split(/\s+/).length;
        const baselineScore = {
          structure:       Math.min(1, wordCount / 100),
          quantification:  content.match(/\d+%|\d+ times|\d+ years/g)?.length ? 0.7 : 0.3,
          iWeRatio:        0.5,
        };
        logger.debug(
          { event: "eval.beh.baseline_scored.dispatch", sessionId, baselineScore },
          "BASELINE_QUESTION: dispatching BASELINE_SCORED"
        );
        await sendAndSettle(actor, { type: "BASELINE_SCORED", score: baselineScore }, sessionId);
        return;
      }

      if (stateName === "CALIBRATE_INTENSITY") {
        // Determine follow-up intensity from level flag.
        const bCtx = ctx as BehavioralMachineContext;
        const intensity: "hard" | "medium" | "scaffolded" =
          bCtx.level === "senior" || bCtx.level === "staff" || bCtx.level === "principal"
            ? "hard"
            : bCtx.level === "junior"
            ? "scaffolded"
            : "medium";
        logger.debug(
          { event: "eval.beh.calibrate_intensity.dispatch", sessionId, intensity, level: bCtx.level },
          `CALIBRATE_INTENSITY: dispatching INTENSITY_CALIBRATED (${intensity})`
        );
        await sendAndSettle(actor, { type: "INTENSITY_CALIBRATED", intensity }, sessionId);
        return;
      }

      if (stateName === "ADVERSITY_SCORING") {
        // Heuristic adversity score — replace with AI scorer when available.
        const bCtx  = ctx as BehavioralMachineContext;
        const score: import("@interview/shared-types").AdversityScore = {
          accountability:  bCtx.iWeRatioRaw > 0.5 ? 0.7 : 0.4,
          recoveryArc:     bCtx.storyExistenceConfirmed ? 0.7 : 0.3,
          noBlame:         true,
          learningQuality: 0.5,
          noHireSignal:    false,
        };
        logger.debug(
          { event: "eval.beh.adversity_scoring.dispatch", sessionId, score },
          "ADVERSITY_SCORING: dispatching ADVERSITY_SCORED"
        );
        await sendAndSettle(actor, { type: "ADVERSITY_SCORED", score }, sessionId);
        return;
      }

      if (stateName === "INFLUENCE_SCORING") {
        // Heuristic influence score — replace with AI scorer when available.
        const score: import("@interview/shared-types").InfluenceScore = {
          scopeLevel:              2,
          stakeholderSpecificity:  0.5,
          frictionHandled:         false,
          businessOutcome:         false,
        };
        logger.debug(
          { event: "eval.beh.influence_scoring.dispatch", sessionId, score },
          "INFLUENCE_SCORING: dispatching INFLUENCE_SCORED"
        );
        await sendAndSettle(actor, { type: "INFLUENCE_SCORED", score }, sessionId);
        return;
      }

      if (stateName === "AUTHENTICITY_FLAGS") {
        // Dispatch empty flags for now — replace with AI detection when available.
        logger.debug(
          { event: "eval.beh.authenticity_flags.dispatch", sessionId },
          "AUTHENTICITY_FLAGS: dispatching AUTHENTICITY_FLAGS_SET (no flags)"
        );
        await sendAndSettle(
          actor,
          { type: "AUTHENTICITY_FLAGS_SET", flags: [] },
          sessionId
        );
        return;
      }

      if (stateName === "HIRE_SIGNAL_CALC" && typeRegistry.get(sessionId) === "behavioral") {
        // Behavioral HIRE_SIGNAL_CALC advances on SCORE_COMPUTED (unlike SD which uses PHASE_COMPLETE).
        // Actions: setDimensionScores + computeHireSignal.
        const bCtx     = ctx as BehavioralMachineContext;
        const transcript = transcriptRegistry.get(sessionId) ?? [];
        const session    = await db.query.interviewSessions.findFirst({
          where:   eq(interviewSessions.id, sessionId),
          columns: { type: true, tier: true },
        });
        if (!session) {
          logger.error({ event: "eval.beh.hire_signal.no_session", sessionId }, "Session not found");
          return;
        }
        logger.info(
          { event: "eval.beh.hire_signal.start", sessionId, transcriptLength: transcript.length },
          "Computing behavioral dimension scores"
        );
        const startMs = Date.now();
        const scoringTranscript = transcript.map((t) => ({
          role: t.role, content: t.content, phase: t.phase, stateName: t.stateName,
        }));
        const { scores, overall } = await computeDimensionScores(
          session!.type, scoringTranscript, bCtx.competencyPlan, session!.tier
        );
        logger.info(
          { event: "eval.beh.hire_signal.result", sessionId, durationMs: Date.now() - startMs, overall },
          `Behavioral scores computed: overall=${overall.toFixed(3)}`
        );
        await sendAndSettle(actor, { type: "SCORE_COMPUTED", scores, overall }, sessionId);
        return;
      }

      if (stateName === "REPORT_BUILDING" && typeRegistry.get(sessionId) === "behavioral") {
        // Behavioral REPORT_BUILDING advances on REPORT_READY (same as domain_knowledge).
        const bCtx     = ctx as BehavioralMachineContext;
        const transcript = transcriptRegistry.get(sessionId) ?? [];
        const session    = await db.query.interviewSessions.findFirst({
          where:   eq(interviewSessions.id, sessionId),
          columns: { type: true, tier: true },
        });
        if (!session) {
          logger.error({ event: "eval.beh.report.no_session", sessionId }, "Session not found");
          return;
        }
        logger.info({ event: "eval.beh.report.start", sessionId }, "Generating behavioral report");
        const startMs = Date.now();
        const scoringTranscript = transcript.map((t) => ({
          role: t.role, content: t.content, phase: t.phase, stateName: t.stateName,
        }));
        const report = await generateReport(
          session!.type, sessionId,
          bCtx.dimensionScores, bCtx.overallScore ?? 0,
          bCtx.hireSignal ?? "no_hire",
          scoringTranscript, session!.tier
        );
        logger.info(
          { event: "eval.beh.report.result", sessionId, durationMs: Date.now() - startMs },
          "Behavioral report generated"
        );
        await sendAndSettle(actor, { type: "REPORT_READY", report }, sessionId);
        return;
      }

      // No matching eval branch — passthrough for states that the machine
      // advances via CANDIDATE_RESPONSE without needing AI evaluation first.
      logger.trace(
        { event: "eval.no_match", sessionId, stateName },
        `No eval branch for state ${stateName} — passthrough`
      );

    } catch (err) {
      // Evaluation errors are non-fatal — the interview continues uninterrupted.
      logger.warn(
        { event: "eval.error", err, sessionId, stateName },
        `Eval error in state ${stateName} (non-fatal — interview continues)`
      );
    }
  }

  // ─── FINALIZE ──────────────────────────────────────────────

  private static async finalize(
    sessionId: string,
    actor: AnyActor,
    userId: string
  ): Promise<void> {
    const finalizeStart = Date.now();
    logger.info(
      { event: "finalize.start", sessionId, userId },
      "Session finalization started"
    );

    // ── Load session row ───────────────────────────────────────
    const session = await db.query.interviewSessions.findFirst({
      where:   eq(interviewSessions.id, sessionId),
      columns: { type: true, tier: true },
    });

    if (!session) {
      logger.error(
        { event: "finalize.session_not_found", sessionId },
        "Session not found in DB during finalization — aborting"
      );
      return;
    }

    logger.debug(
      {
        event:     "finalize.session_loaded",
        sessionId,
        type:      session.type,
        tier:      session.tier,
      },
      "Session metadata loaded"
    );

    const ctx        = (actor.getSnapshot() as AnyMachineSnapshot).context as unknown as AnyContext;
    const transcript = transcriptRegistry.get(sessionId) ?? [];

    const candidateMessages   = transcript.filter((t) => t.role === "candidate").length;
    const interviewerMessages = transcript.filter((t) => t.role === "interviewer").length;
    const phases              = [...new Set(transcript.map((t) => t.phase))];

    logger.info(
      {
        event:                "finalize.transcript_summary",
        sessionId,
        transcriptLength:     transcript.length,
        candidateMessages,
        interviewerMessages,
        phases,
        totalExchanges:       ctx.totalExchanges,
        probeCount:           ctx.probeCount,
        redirectCount:        ctx.redirectCount,
        silenceEvents:        ctx.silenceEvents,
      },
      `Transcript: ${transcript.length} messages across ${phases.length} phase(s)`
    );

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

    // ── Compute dimension scores ───────────────────────────────
    logger.info(
      {
        event:             "finalize.scoring.start",
        sessionId,
        type:              session.type,
        tier:              session.tier,
        transcriptLength:  scoringTranscript.length,
      },
      "Computing dimension scores"
    );

    const scoringStart = Date.now();
    const result: {
      scores:     DimensionScore[];
      overall:    number;
      hireSignal: HireSignal;
    } = await computeDimensionScores(
      session.type,
      scoringTranscript,
      plan,
      session.tier
    );

    logger.info(
      {
        event:          "finalize.scoring.complete",
        sessionId,
        durationMs:     Date.now() - scoringStart,
        dimensionCount: result.scores.length,
        overall:        result.overall,
        hireSignal:     result.hireSignal,
        dimensions:     result.scores.map((s) => ({ dimension: s.dimension, score: s.score })),
      },
      `Scoring complete: overall=${result.overall.toFixed(3)}, signal=${result.hireSignal}`
    );

    // ── Generate report ────────────────────────────────────────
    logger.info(
      { event: "finalize.report.start", sessionId },
      "Generating interview report"
    );

    const reportStart = Date.now();
    const report: InterviewReport = await generateReport(
      session.type,
      sessionId,
      result.scores,
      result.overall,
      result.hireSignal,
      scoringTranscript,
      session.tier
    );

    logger.info(
      {
        event:      "finalize.report.complete",
        sessionId,
        durationMs: Date.now() - reportStart,
      },
      "Interview report generated"
    );

    // ── Persist dimension scores ───────────────────────────────
    if (result.scores.length > 0) {
      logger.debug(
        { event: "finalize.scores.persisting", sessionId, count: result.scores.length },
        `Persisting ${result.scores.length} dimension scores`
      );
      await db.insert(dimensionScores).values(
        result.scores.map((s) => ({
          sessionId,
          dimension:         s.dimension,
          score:             s.score,
          evidence:          s.evidence,
          transcriptIndices: s.transcriptIndices,
        }))
      );
      logger.debug(
        { event: "finalize.scores.persisted", sessionId, count: result.scores.length },
        "Dimension scores persisted"
      );
    } else {
      logger.warn(
        { event: "finalize.scores.empty", sessionId },
        "No dimension scores returned — skipping insert"
      );
    }

    // ── Mark session completed ─────────────────────────────────
    logger.debug(
      {
        event:        "finalize.session.completing",
        sessionId,
        hireSignal:   result.hireSignal,
        overallScore: result.overall,
      },
      "Marking session as completed in DB"
    );

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

    logger.debug(
      { event: "finalize.session.completed", sessionId },
      "Session row marked completed"
    );

    // ── Update user aggregates ─────────────────────────────────
    logger.debug(
      { event: "finalize.aggregates.updating", sessionId, userId },
      "Updating user interview aggregates"
    );

    // Read current values first so we can compute the running average in
    // TypeScript. The previous SQL expression divided by (completed_sessions+1)
    // while also incrementing in the same query, producing a wrong denominator.
    const existingAgg = await db.query.userInterviewAggregates.findFirst({
      where:   eq(userInterviewAggregates.userId, userId),
      columns: { completedSessions: true, avgOverallScore: true },
    });
    const prevCompleted = existingAgg?.completedSessions ?? 0;
    const prevAvg       = existingAgg?.avgOverallScore   ?? 0;
    const newCompleted  = prevCompleted + 1;
    const newAvg        = (prevAvg * prevCompleted + result.overall) / newCompleted;

    await db
      .update(userInterviewAggregates)
      .set({
        totalSessions:     sql`total_sessions + 1`,
        completedSessions: newCompleted,
        avgOverallScore:   newAvg,
        lastSessionAt:     new Date(),
        updatedAt:         new Date(),
      })
      .where(eq(userInterviewAggregates.userId, userId));

    logger.debug(
      { event: "finalize.aggregates.updated", sessionId, userId },
      "User aggregates updated"
    );

    // ── Clean up in-memory registries ─────────────────────────
    actorRegistry.delete(sessionId);
    transcriptRegistry.delete(sessionId);
    typeRegistry.delete(sessionId);

    logger.info(
      {
        event:                    "finalize.complete",
        sessionId,
        userId,
        hireSignal:               result.hireSignal,
        overallScore:             result.overall,
        totalDurationMs:          Date.now() - finalizeStart,
        remainingActiveSessions:  actorRegistry.size,
      },
      `Session finalized in ${Date.now() - finalizeStart}ms — signal=${result.hireSignal}, score=${result.overall.toFixed(3)}`
    );
  }

  // ─── SNAPSHOT PERSISTENCE ──────────────────────────────────

  private static async persistSnapshot(
    sessionId: string,
    snap: AnyMachineSnapshot
  ): Promise<void> {
    const ctx       = snap.context as unknown as AnyContext;
    const stateName = snapToStateName(snap);

    logger.trace(
      {
        event:         "db.snapshot.persisting",
        sessionId,
        stateName,
        phase:         ctx.phase,
        machineStatus: snap.status,
      },
      `Persisting snapshot: ${stateName}`
    );

    await db
      .update(interviewSessions)
      .set({
        currentPhase:         ctx.phase,
        stateMachineSnapshot: snap as unknown as typeof interviewSessions.$inferInsert["stateMachineSnapshot"],
        updatedAt:            new Date(),
      })
      .where(eq(interviewSessions.id, sessionId));

    logger.trace(
      { event: "db.snapshot.persisted", sessionId, stateName, phase: ctx.phase },
      `Snapshot persisted: ${stateName}`
    );
  }

  // ─── HELPERS ───────────────────────────────────────────────

  static snapToStateName(snap: AnyMachineSnapshot): string {
    return snapToStateName(snap);
  }

  private static buildPlanContext(ctx: AnyContext): string {
    // System design — use activeProbeIndex, not always questions[0]
    if (ctx.interviewObject?.questions) {
      const idx = Math.min(ctx.activeProbeIndex ?? 0, ctx.interviewObject.questions.length - 1);
      const q = ctx.interviewObject.questions[idx];
      return q ? `Current question: ${q.content}\nPhase: ${idx + 1} of ${ctx.interviewObject.questions.length}` : "";
    }
    // Behavioral — use currentCompetencyIndex
    const bCtx = ctx as BehavioralMachineContext;
    if (Array.isArray(bCtx.competencyPlan) && bCtx.competencyPlan.length > 0) {
      const item = bCtx.competencyPlan[bCtx.currentCompetencyIndex];
      return item
        ? `Competency: ${item.competency}\nQuestion: ${item.question}\nExpected scope: ${item.expectedScope}`
        : "";
    }
    // Domain knowledge — use currentDomain index and expose all 3 question types
    const dCtx = ctx as DomainKnowledgeMachineContext;
    if (Array.isArray(dCtx.domainPlan) && dCtx.domainPlan.length > 0) {
      const domainIndex = Math.min(dCtx.currentDomain ?? 0, dCtx.domainPlan.length - 1);
      const item = dCtx.domainPlan[domainIndex];
      return item
        ? `Domain: ${item.domain}\nConceptual Q: ${item.questions.conceptual}\nApplied Q: ${item.questions.applied}\nEdge case Q: ${item.questions.edgeCase}`
        : "";
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
      role:          "interviewer" | "candidate" | "system";
      type:          MessageType;
      content:       string;
      phase:         number;
      stateName:     string;
      metadata:      Record<string, unknown>;
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