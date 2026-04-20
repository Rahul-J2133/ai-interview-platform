/**
 * apps\api\src\services\session-controller.ts
 *
 * InterviewSessionController
 *
 * Single class responsible for the full session lifecycle:
 *   1. Create and start the correct XState v5 actor
 *   2. Run pre-session AI plan generation (adaptive domain count, context-mode tagging)
 *   3. Route candidate messages to state-specific evaluators
 *   4. Persist every state change and transcript message to Postgres
 *   5. Run final scoring + report generation on completion
 *
 * Identity rule: every DB operation uses our internal UUID (users.id).
 * The Clerk user ID never appears in this file.
 *
 * Adaptive domain plan
 * ────────────────────
 * The domain plan now supports 2–5 domains (not a hard 3) chosen by the
 * AI planner based on resume strength.  generateDomainPlan returns a
 * planContextMode tag ("resume_jd" | "jd_only" | "resume_only" |
 * "exploratory") that is threaded into the machine context and forwarded
 * to generateInterviewerResponse so the AI layer can calibrate question
 * difficulty per-domain.
 *
 * Transcript-grounded follow-ups
 * ───────────────────────────────
 * generateInterviewerResponse now receives the full running transcript
 * and a resumeEvidence map (resume lines keyed by domain) so every
 * follow-up question can reference what the candidate actually said
 * and tie probes back to specific resume claims.
 *
 * Logging strategy
 * ────────────────
 * Every meaningful step emits a structured log with a stable `event` field:
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
import { logger, smLogger } from "../lib/logger";

// ============================================================
// TYPES
// ============================================================

export interface SessionInput {
  sessionId:             string;
  userId:                string;   // Our internal UUID — never Clerk ID
  type:                  InterviewType;
  tier:                  InterviewTier;
  level:                 InterviewLevel;
  role:                  string;
  jdText:                string | null;
  /**
   * Resolved resume text — callers must merge parsedResumeText ?? resumeText
   * before constructing this input. The controller no longer accepts two
   * separate resume fields to avoid the DB/AI divergence that previously
   * occurred when only one field was provided.
   */
  resumeText:            string | null;
  priorSdScore?:         number | null;
  priorBehavioralScore?: number | null;
}

/**
 * Merged context type for the session controller.
 * All three machine contexts are intersected so the controller can read any
 * field without per-machine casts everywhere.  Fields that only exist on one
 * context are declared optional.
 *
 * NOTE: DomainKnowledgeMachineContext now uses nested phase slices
 * (phase1, phase2, … phase6).  Access those via
 *   (ctx as DomainKnowledgeMachineContext).phase1.misconceptionsDetected
 * rather than the flat fields that existed in the old context shape.
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

type AnyActor           = Actor<AnyMachine>;
type AnyMachineSnapshot = SnapshotFrom<AnyMachine>;

interface TranscriptEntry {
  role:      "interviewer" | "candidate";
  content:   string;
  phase:     number;
  stateName: string;
}

// States in which the machine has not yet reached its first live interview
// state.  handleCandidateResponse rejects messages arriving while any of
// these is active.
//
// IMPORTANT: With the compound-state refactor the machine's .value for a
// nested state is an object, e.g. { PRE_SESSION: "DOMAIN_TAXONOMY_LOAD" }.
// snapToStateName() extracts the leaf node name, so these sets continue to
// work with plain string comparisons.
const PRE_SESSION_STATES = new Set([
  "IDLE",
  // system_design machine pre-session states
  "PARSING_INPUTS",
  "GENERATING_OBJ",
  "INTERVIEW_READY",
  // behavioral machine pre-session states
  "PARSING_RESUME",
  "JD_COMPETENCY_MAP",
  "COMPETENCY_PLAN_GEN",
  // domain_knowledge machine pre-session states (inside PRE_SESSION compound)
  "DOMAIN_TAXONOMY_LOAD",
  "RESUME_DOMAIN_PARSE",
  "DOMAIN_PLAN_GEN",
  // shared across behavioral and domain_knowledge
  "QUALITY_GATE",
  "PLAN_READY",
]);

// States where the machine genuinely pauses and waits for the next candidate
// input.  When the machine lands here after processing a response, the turn is
// complete and control returns to the WS layer.
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
  // behavioral fallback resting state
  "FALLBACK_PROMPT",
  // domain_knowledge — leaf state names inside compound states
  "CONCEPTUAL_QUESTION", "APPLIED_QUESTION", "WAR_STORY_PROBE",
  "EDGE_CASE_QUESTION", "ADJACENT_DOMAIN_TEST", "D2_FLOWING_CONVO",
  "STRETCH_FRAMING", "FIRST_PRINCIPLES_TEST", "LEARNING_VELOCITY",
  "DELIBERATE_CHALLENGE",
]);

const TERMINAL_STATES = new Set(["TERMINAL_COMPLETED", "ERROR_STATE"]);

// ============================================================
// IN-MEMORY REGISTRIES
// sessionId → actor / transcript / interview type
//
// In production: replace with Redis-backed actor snapshot store so sessions
// survive process restarts and scale horizontally.
// ============================================================

const actorRegistry          = new Map<string, AnyActor>();
const transcriptRegistry     = new Map<string, TranscriptEntry[]>();
const typeRegistry           = new Map<string, InterviewType>();

/**
 * Stores the pre-generated opening question for a session.
 *
 * The opening question is generated at the end of runPreSession — before
 * any WS connection exists — so it cannot be streamed immediately.  The WS
 * server reads and clears this map the moment the first connection is
 * established, replaying the message to the client as a normal
 * interviewer_message frame.
 */
const openingMessageRegistry = new Map<string, string>();

// ============================================================
// MODULE-LEVEL HELPERS
// ============================================================

/**
 * Yields to the macrotask queue (one full event-loop tick) so XState v5 can
 * fully commit every in-flight transition before the next event is sent.
 *
 * Why a macrotask instead of a microtask
 * ───────────────────────────────────────
 * XState v5 processes the state transition itself synchronously on actor.send(),
 * but it defers two categories of work to later ticks:
 *
 *   1. Microtask-deferred: entry action scheduling, context assignment.
 *   2. Macrotask-deferred: `after` delayed-transition setup (setTimeout(0)),
 *      invoked actor initialisation.
 *
 * Using setImmediate (which runs AFTER all pending setTimeout(0) callbacks)
 * guarantees the machine has fully committed every entry action and timer
 * setup before the next send() call arrives.
 */
const yieldMacrotask = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * Standalone state-name extractor.
 *
 * XState v5 .value is a string for flat states and a nested object for
 * compound states, e.g. { PRE_SESSION: "DOMAIN_TAXONOMY_LOAD" }.
 * We always want the leaf node name for logging and set membership tests.
 */
function snapToStateName(snap: AnyMachineSnapshot): string {
  const v = snap.value;
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    // Compound state: { ParentState: "LeafState" } or deeper nesting.
    // Recurse one level — interviews are at most 2 levels deep.
    const child = Object.values(v as Record<string, unknown>)[0];
    if (typeof child === "string") return child;
    if (child && typeof child === "object") {
      return Object.values(child as Record<string, unknown>)[0] as string ?? "UNKNOWN_NESTED";
    }
    return Object.keys(v as Record<string, unknown>)[0] ?? "UNKNOWN_NESTED";
  }
  return "UNKNOWN";
}

/**
 * sendAndSettle — send an XState event, yield one macrotask so the machine
 * finishes transitioning, then log the before/after state pair at trace level.
 *
 * Using this wrapper everywhere gives a complete, searchable record of every
 * event sent and every state transition in the logs without manually adding
 * logging around each individual send.
 */
async function sendAndSettle(
  actor:     AnyActor,
  event:     Record<string, unknown> & { type: string },
  sessionId: string
): Promise<void> {
  const stateBefore = snapToStateName(actor.getSnapshot() as AnyMachineSnapshot);
  logger.trace(
    { event: "xstate.send", sessionId, eventType: event.type, stateBefore },
    `→ Sending ${event.type} (in ${stateBefore})`
  );

  actor.send(event as never);
  await yieldMacrotask();

  const stateAfter   = snapToStateName(actor.getSnapshot() as AnyMachineSnapshot);
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
   * Build the actor, run pre-session plan generation, and wait until the
   * machine reaches its first live interview state before returning.
   * The HTTP route must await this so the session is fully ready before the
   * 201 response is sent to the client.
   */
  static async initialize(input: SessionInput): Promise<void> {
    logger.info(
      {
        event:                   "session.initialize.start",
        sessionId:               input.sessionId,
        userId:                  input.userId,
        type:                    input.type,
        tier:                    input.tier,
        level:                   input.level,
        role:                    input.role,
        hasJd:                   !!input.jdText,
        jdLength:                input.jdText?.length ?? 0,
        hasResume:               !!input.resumeText,
        resumeLength:            input.resumeText?.length ?? 0,
        hasPriorSdScore:         input.priorSdScore        != null,
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
        event:        "session.actor.registered",
        sessionId:    input.sessionId,
        type:         input.type,
        registrySize: actorRegistry.size,
      },
      "Actor built and registered in memory"
    );

    // Subscribe for trace logging.  Snapshot persistence is handled by the
    // explicit db.update in handleCandidateResponse (after pump settles).
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

      smLogger.trace(
        {
          event:     "xstate.snapshot.received",
          sessionId: input.sessionId,
          stateName,
          status:    snap.status,
          context:   (snap as AnyMachineSnapshot).context,
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
            priorSdScore:         input.priorSdScore         ?? null,
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
   * domain_knowledge specifics
   * ──────────────────────────
   * generateDomainPlan now returns { plan, contextMode } where:
   *   - plan        is a variable-length DomainPlan[] (2–5 domains)
   *   - contextMode is "resume_jd" | "jd_only" | "resume_only" | "exploratory"
   *
   * The plan length is determined by the AI planner based on how many
   * meaningful domain clusters it finds in the resume + JD.  When both are
   * absent the planner generates an exploratory plan with open-ended discovery
   * questions rather than domain-specific ones.
   *
   * PLAN_GENERATED now carries { plan, contextMode } so the machine can store
   * planContextMode in context and forward it to downstream AI calls.
   *
   * Event sequences per machine type
   * ─────────────────────────────────
   * system_design:
   *   START_SESSION → INPUTS_PARSED → PLAN_GENERATED → QUALITY_GATE_PASS
   *   → CANDIDATE_READY
   *
   * behavioral:
   *   START_SESSION → INPUTS_PARSED → PHASE_COMPLETE → PLAN_GENERATED
   *   → QUALITY_GATE_PASS → CANDIDATE_READY
   *
   * domain_knowledge (inside PRE_SESSION compound):
   *   START_SESSION  → PRE_SESSION.DOMAIN_TAXONOMY_LOAD
   *   INPUTS_PARSED  → PRE_SESSION.RESUME_DOMAIN_PARSE
   *   PHASE_COMPLETE → PRE_SESSION.DOMAIN_PLAN_GEN
   *   PLAN_GENERATED → PRE_SESSION.QUALITY_GATE
   *   QUALITY_GATE_PASS → PRE_SESSION.PLAN_READY
   *   CANDIDATE_READY → PHASE_1_CONCEPTUAL.CONCEPTUAL_QUESTION (first live state)
   */
  private static async runPreSession(
    input: SessionInput,
    actor: AnyActor
  ): Promise<void> {
    logger.info(
      { event: "presession.start", sessionId: input.sessionId, type: input.type },
      "Pre-session phase started"
    );

    await sendAndSettle(actor, { type: "START_SESSION" }, input.sessionId);

    try {
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

          await sendAndSettle(actor, { type: "INPUTS_PARSED" },        input.sessionId);
          await sendAndSettle(actor, { type: "PHASE_COMPLETE" },        input.sessionId);
          await sendAndSettle(actor, { type: "PLAN_GENERATED", plan }, input.sessionId);
          await sendAndSettle(actor, { type: "QUALITY_GATE_PASS" },   input.sessionId);
          await sendAndSettle(actor, { type: "CANDIDATE_READY" },     input.sessionId);
          break;
        }

        case "domain_knowledge": {
          // ── Adaptive domain plan generation ─────────────────────────────────
          //
          // generateDomainPlan now returns { plan, contextMode } where plan is a
          // variable-length array (2–5 domains) and contextMode describes the
          // quality of input available to the planner.
          //
          // planContextMode is threaded into the machine context via the
          // PLAN_GENERATED event and later forwarded to generateInterviewerResponse
          // so the AI layer can adjust question difficulty per-domain and per-context.
          //
          // When both resumeText and jdText are null the planner produces an
          // "exploratory" plan with open-ended discovery questions designed to
          // surface the candidate's actual areas of expertise before testing them.
          // generateDomainPlan returns DomainPlan[] today.
          // When the ai-engine is updated to return { plan, contextMode }
          // replace these two lines with a single destructure.
          const rawDomainResult = await generateDomainPlan(
            input.role, input.level, input.jdText, input.resumeText
          );
          const plan: DomainPlan[] = Array.isArray(rawDomainResult)
            ? rawDomainResult
            : (rawDomainResult as { plan: DomainPlan[] }).plan;
          const contextMode: DomainKnowledgeMachineContext["planContextMode"] =
            Array.isArray(rawDomainResult)
              ? (input.resumeText && input.jdText ? "resume_jd"
                : input.resumeText               ? "resume_only"
                : input.jdText                   ? "jd_only"
                :                                  "exploratory")
              : (rawDomainResult as { contextMode: DomainKnowledgeMachineContext["planContextMode"] }).contextMode;

          logger.info(
            {
              event:       "presession.plan.generated",
              sessionId:   input.sessionId,
              type:        "domain_knowledge",
              durationMs:  Date.now() - planStartMs,
              domainCount: plan?.length ?? 0,
              contextMode,
              domains:     plan?.map((d: DomainPlan) => d.domain) ?? [],
            },
            `Domain-knowledge plan generated in ${Date.now() - planStartMs}ms ` +
            `(${plan?.length ?? 0} domains, mode=${contextMode})`
          );

          // PRE_SESSION compound state event sequence (verified against machine.ts):
          //   INPUTS_PARSED  → PRE_SESSION.RESUME_DOMAIN_PARSE
          //   PHASE_COMPLETE → PRE_SESSION.DOMAIN_PLAN_GEN
          //   PLAN_GENERATED → PRE_SESSION.QUALITY_GATE  (carries contextMode)
          //   QUALITY_GATE_PASS → PRE_SESSION.PLAN_READY
          //   CANDIDATE_READY → PHASE_1_CONCEPTUAL.CONCEPTUAL_QUESTION
          await sendAndSettle(actor, { type: "INPUTS_PARSED" },                        input.sessionId);
          await sendAndSettle(actor, { type: "PHASE_COMPLETE" },                       input.sessionId);
          await sendAndSettle(actor, { type: "PLAN_GENERATED", plan, contextMode },    input.sessionId);
          await sendAndSettle(actor, { type: "QUALITY_GATE_PASS" },                   input.sessionId);
          await sendAndSettle(actor, { type: "CANDIDATE_READY" },                     input.sessionId);
          break;
        }

        default: {
          const _exhaustive: never = input.type;
          throw new Error(`Unknown type in runPreSession: ${String(_exhaustive)}`);
        }
      }

      // ── Generate opening question ──────────────────────────────────────────
      //
      // The interviewer always speaks first.  We generate the opening question
      // here, during pre-session, so it is ready to be flushed the instant the
      // candidate's WS connection is established — without any round-trip delay.
      //
      //   1. runPreSession drives the machine to its first live state
      //   2. We generate + persist the opening message as seq=0
      //   3. The 201 response is returned to the client
      //   4. The client connects via WS; the server flushes the stored message
      //
      // The candidate never has to send a blank "start" message.
      const finalStateName = snapToStateName(actor.getSnapshot() as AnyMachineSnapshot);

      try {
        const openingSnap = actor.getSnapshot() as AnyMachineSnapshot;
        const openingCtx  = openingSnap.context as unknown as AnyContext;
        const planContext = InterviewSessionController.buildPlanContext(openingCtx);

        logger.info(
          {
            event:        "presession.opening.generating",
            sessionId:    input.sessionId,
            state:        finalStateName,
            phase:        openingCtx.phase,
            planContext:  planContext.slice(0, 120),
          },
          "Generating opening interviewer question"
        );

        const openingStartMs = Date.now();

        // Fold planContextMode and resumeEvidence into the planContext string
        // so the AI has full signal without requiring InterviewerContext to be
        // extended.  When ai-engine adds those typed fields, promote them back.
        const enrichedPlanContext = InterviewSessionController.enrichPlanContext(
          planContext, openingCtx
        );

        const openingQuestion = await generateInterviewerResponse({
          interviewType:     input.type,
          role:              input.role,
          level:             input.level,
          currentPhase:      openingCtx.phase,
          currentState:      finalStateName,
          transcript:        [], // empty — this is the very first turn
          planContext:       enrichedPlanContext,
          activeProbeIndex:  0,
          followUpIntensity: "medium",
        });

        logger.info(
          {
            event:      "presession.opening.generated",
            sessionId:  input.sessionId,
            durationMs: Date.now() - openingStartMs,
            length:     openingQuestion.length,
            preview:    openingQuestion.slice(0, 120),
          },
          `Opening question generated in ${Date.now() - openingStartMs}ms`
        );

        const transcript = transcriptRegistry.get(input.sessionId) ?? [];
        transcript.push({
          role:      "interviewer",
          content:   openingQuestion,
          phase:     openingCtx.phase,
          stateName: finalStateName,
        });
        transcriptRegistry.set(input.sessionId, transcript);

        await InterviewSessionController.persistMsg(input.sessionId, {
          sequenceIndex: 0,
          role:          "interviewer",
          type:          "question",
          content:       openingQuestion,
          phase:         openingCtx.phase,
          stateName:     finalStateName,
          metadata:      { openingQuestion: true },
        });

        openingMessageRegistry.set(input.sessionId, openingQuestion);

        logger.debug(
          { event: "presession.opening.stored", sessionId: input.sessionId },
          "Opening question stored — will be flushed on first WS connection"
        );

      } catch (openingErr) {
        // Opening question generation is non-fatal.  The session is still usable;
        // the first candidate message will trigger a normal AI response.
        logger.warn(
          {
            event:     "presession.opening.failed",
            err:       openingErr,
            sessionId: input.sessionId,
          },
          "Failed to generate opening question — session still usable, candidate must speak first"
        );
      }

      // ── Write ready status to DB ─────────────────────────────────────────────
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
    content:   string,
    userId:    string,
    /**
     * Optional streaming callback.  When provided, the AI response is streamed
     * chunk-by-chunk via this callback as it arrives from the model.  The
     * resolved `interviewerResponse` in the return value will be the complete
     * accumulated text (identical to the non-streaming case), so callers that
     * don't stream can still read the full string from the return value.
     */
    onChunk?: (chunk: string) => void
  ): Promise<{
    interviewerResponse: string;
    stateUpdate:         { phase: number; stateName: string };
    isComplete:          boolean;
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

    // ── 1. Actor lookup — with snapshot recovery ─────────────────────────────
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
        case "system_design":    machine = systemDesignMachine    as unknown as AnyMachine; break;
        case "behavioral":       machine = behavioralMachine      as unknown as AnyMachine; break;
        case "domain_knowledge": machine = domainKnowledgeMachine as unknown as AnyMachine; break;
        default: throw new Error(`Unknown interview type: ${row.type}`);
      }

      // XState v5: createActor() requires `input` in its options type even when
      // restoring from a snapshot.  At runtime, XState ignores `input` entirely
      // when a `snapshot` is provided — the full context is carried by the
      // snapshot.  We satisfy the type checker by casting options to `any`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const restoredActor = createActor(machine, { snapshot: row.stateMachineSnapshot, input: undefined } as any) as unknown as AnyActor;
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

    // ── 2. Pre-session guard ──────────────────────────────────────────────────
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

    // ── 3. Persist candidate message ─────────────────────────────────────────
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

    // ── 4. Run eval for the current state, then advance via CANDIDATE_RESPONSE ─
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
    //
    // After CANDIDATE_RESPONSE the machine may land in an intermediate state
    // (e.g. MISCONCEPTION_DETECT, CONFIDENCE_CALIBRATE) that is NOT a stable
    // resting point — it needs eval dispatched and possibly further advances
    // before control should return to the WS layer.
    //
    // pumpToRest() drives the machine through all such intermediate states in
    // one turn until it reaches a CANDIDATE_AWAITING_STATES member or a
    // terminal state.
    await sendAndSettle(actor, { type: "CANDIDATE_RESPONSE", content }, sessionId);

    let pumpIterations = 0;
    const MAX_PUMP_ITERATIONS = 40; // no interview has >40 intermediate states

    while (true) {
      const pumpSnap       = actor.getSnapshot() as AnyMachineSnapshot;
      const pumpState      = snapToStateName(pumpSnap);
      const pumpIsTerminal = pumpSnap.status === "done" || TERMINAL_STATES.has(pumpState);
      const pumpIsResting  = CANDIDATE_AWAITING_STATES.has(pumpState);

      if (pumpIsTerminal || pumpIsResting) {
        logger.debug(
          {
            event:         "pump.stopped",
            sessionId,
            pumpState,
            pumpIterations,
            reason:        pumpIsTerminal ? "terminal" : "candidate_awaiting",
          },
          `Pump stopped at ${pumpState} after ${pumpIterations} iteration(s)`
        );
        break;
      }

      if (pumpIterations >= MAX_PUMP_ITERATIONS) {
        logger.error(
          {
            event:         "pump.max_iterations",
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

      await InterviewSessionController.runEval(
        actor, sessionId, content, pumpCtx, pumpState
      );

      const afterEvalSnap  = actor.getSnapshot() as AnyMachineSnapshot;
      const afterEvalState = snapToStateName(afterEvalSnap);

      if (afterEvalState === pumpState) {
        // runEval did not move the machine — state is stuck.  This means the
        // state needs a CANDIDATE_RESPONSE to advance.  But we already sent it
        // — this state should be in CANDIDATE_AWAITING_STATES.  Log and break.
        logger.warn(
          {
            event:         "pump.no_progress",
            sessionId,
            pumpState,
            pumpIterations,
          },
          `Pump: runEval did not advance state ${pumpState} — breaking. ` +
          `Add to CANDIDATE_AWAITING_STATES if this state awaits candidate input.`
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

    // ── 6. Generate interviewer response ──────────────────────────────────────
    let interviewerResponse = "";

    if (!isComplete) {
      const planContext   = InterviewSessionController.buildPlanContext(newCtx);
      const msgType       = InterviewSessionController.classifyMsgType(newStateName);

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

      // enrichPlanContext appends planContextMode and per-domain resumeEvidence
      // to the planContext string so the AI has full signal without requiring
      // InterviewerContext to carry new typed fields.
      const enrichedPlanContext = InterviewSessionController.enrichPlanContext(
        planContext, newCtx
      );

      interviewerResponse = await generateInterviewerResponse(
        {
          interviewType:     typeRegistry.get(sessionId) ?? "system_design",
          role:              newCtx.role,
          level:             newCtx.level,
          currentPhase:      newCtx.phase,
          currentState:      newStateName,
          // Full transcript is passed so the AI can reference specific answers
          // and build genuinely transcript-grounded follow-ups.
          transcript:        transcript.map((t) => ({ role: t.role, content: t.content })),
          planContext:       enrichedPlanContext,
          activeProbeIndex:  newCtx.activeProbeIndex ?? 0,
          followUpIntensity: (newCtx as BehavioralMachineContext).followUpIntensity ?? "medium",
        },
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

    // ── 7. Persist updated session row ────────────────────────────────────────
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

    // ── 8. Finalize if terminal ───────────────────────────────────────────────
    if (isComplete && newStateName === "TERMINAL_COMPLETED") {
      logger.info(
        { event: "session.finalize.trigger", sessionId, stateName: newStateName },
        "TERMINAL_COMPLETED reached — triggering finalization"
      );
      await InterviewSessionController.finalize(sessionId, actor, userId);
    } else if (isComplete) {
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

  /**
   * runEval
   *
   * Dispatches AI-evaluated events for states that need scoring before the
   * machine can advance.  For states that only need a PHASE_COMPLETE nudge
   * (no AI work required) we send it directly and return.
   *
   * Domain knowledge context shape change
   * ──────────────────────────────────────
   * The DomainKnowledgeMachineContext now uses nested phase slices.  All
   * reads from old flat fields (e.g. ctx.misconceptionsDetected) must go
   * through the appropriate slice (e.g. dCtx.phase1.misconceptionsDetected).
   */
  private static async runEval(
    actor:     AnyActor,
    sessionId: string,
    content:   string,
    ctx:       AnyContext,
    stateName: string
  ): Promise<void> {
    try {

      // ══════════════════════════════════════════════════════════════════════
      // SYSTEM DESIGN
      // ══════════════════════════════════════════════════════════════════════

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

      // ══════════════════════════════════════════════════════════════════════
      // BEHAVIORAL
      // ══════════════════════════════════════════════════════════════════════

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
        const bCtx     = ctx as BehavioralMachineContext;
        const planItem = bCtx.competencyPlan[bCtx.currentCompetencyIndex];

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
              event:      "eval.star_parse.result",
              sessionId,
              competency: planItem.competency,
              durationMs: Date.now() - startMs,
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

      // ══════════════════════════════════════════════════════════════════════
      // DOMAIN KNOWLEDGE
      //
      // Context shape note: all per-phase fields are accessed through the
      // phase slice (dCtx.phase1, dCtx.phase2, …).  The old flat fields no
      // longer exist on the context.
      // ══════════════════════════════════════════════════════════════════════

      if (stateName === "MISCONCEPTION_DETECT") {
        const dCtx       = ctx as DomainKnowledgeMachineContext;
        const domainItem = dCtx.domainPlan[dCtx.currentDomain];

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
        const startMs                          = Date.now();
        const { overconfident, underconfident } = await assessConfidence(content);
        logger.info(
          {
            event:         "eval.confidence.result",
            sessionId,
            overconfident,
            underconfident,
            durationMs:    Date.now() - startMs,
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
        // Advance to REASONING_DEPTH_EVAL.  Coachability scoring happens
        // synchronously in the COACHABILITY_SCORING handler below — NOT here.
        logger.debug(
          { event: "eval.response_classify.advance", sessionId },
          "RESPONSE_CLASSIFY: advancing to REASONING_DEPTH_EVAL"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "COACHABILITY_SCORING") {
        // Score synchronously here, in the correct state.  The last interviewer
        // message is the deliberate challenge — use it as the challenge text.
        const localTranscript = transcriptRegistry.get(sessionId) ?? [];
        const lastInterviewer = [...localTranscript].reverse().find((m) => m.role === "interviewer");
        const challenge       = lastInterviewer?.content ?? "";
        logger.debug(
          { event: "eval.coachability.start", sessionId, challengeLength: challenge.length },
          "COACHABILITY_SCORING: scoring synchronously"
        );
        const startMs = Date.now();
        const score   = await scoreCoachability(challenge, content);
        logger.info(
          { event: "eval.coachability.result", sessionId, score, durationMs: Date.now() - startMs },
          `Coachability score: ${score.toFixed(3)}`
        );
        await sendAndSettle(actor, { type: "COACHABILITY_SCORED", score }, sessionId);
        return;
      }

      if (stateName === "CROSS_DOMAIN_LINK") {
        // After D2_FLOWING_CONVO CANDIDATE_RESPONSE the machine enters
        // CROSS_DOMAIN_LINK.  Advance through pacing — d2ExchangeCount on the
        // phase4 slice is incremented by the markCrossDomainLinked action.
        logger.debug(
          { event: "eval.cross_domain_link.advance", sessionId },
          "CROSS_DOMAIN_LINK: advancing to D2_PACING"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "D2_PACING") {
        // Use the guard result to decide whether to exit D2 or continue.
        // The guard checks dCtx.phase4.d2ExchangeCount >= limit || d2RedirectIssued.
        // We replicate that logic here so the correct event is dispatched.
        const dCtx  = ctx as DomainKnowledgeMachineContext;
        // Keep in sync with D2_EXCHANGE_LIMIT in machine.ts.
        // session-controller runs in Node so process.env is available here.
        const limit = typeof process !== "undefined" && process.env?.NODE_ENV === "production" ? 8 : 2;
        const shouldExitD2 =
          dCtx.phase4.d2ExchangeCount >= limit ||
          dCtx.phase4.d2RedirectIssued;

        if (shouldExitD2) {
          logger.info(
            {
              event:          "eval.d2_pacing.exit",
              sessionId,
              d2ExchangeCount: dCtx.phase4.d2ExchangeCount,
              d2RedirectIssued: dCtx.phase4.d2RedirectIssued,
            },
            "D2_PACING: exchange limit reached — exiting to D2_SCORING"
          );
          await sendAndSettle(actor, { type: "TIMEOUT" }, sessionId);
        } else {
          logger.debug(
            {
              event:          "eval.d2_pacing.continue",
              sessionId,
              d2ExchangeCount: dCtx.phase4.d2ExchangeCount,
            },
            "D2_PACING: continuing — advancing to D2_FLOWING_CONVO"
          );
          await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        }
        return;
      }

      if (stateName === "D2_REDIRECT") {
        // issueD2Redirect action already fired on entry.  Resume D2.
        logger.debug(
          { event: "eval.d2_redirect.advance", sessionId },
          "D2_REDIRECT: advancing back to D2_FLOWING_CONVO"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "PROD_SIGNAL_DETECT") {
        logger.debug(
          { event: "eval.prod_signal_detect.advance", sessionId },
          "PROD_SIGNAL_DETECT: auto-advancing to WAR_STORY_PROBE"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "MISCONCEPTION_RESOLUTION") {
        logger.debug(
          { event: "eval.misconception_resolution.advance", sessionId },
          "MISCONCEPTION_RESOLUTION: auto-advancing to IDK_HANDLING"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "IDK_HANDLING") {
        logger.debug(
          { event: "eval.idk_handling.advance", sessionId },
          "IDK_HANDLING: no IDK detected — auto-advancing to ADJACENT_DOMAIN_TEST"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "REASONING_DEPTH_EVAL") {
        logger.debug(
          { event: "eval.reasoning_depth.advance", sessionId },
          "REASONING_DEPTH_EVAL: auto-advancing to COACHABILITY_SCORING"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "CLAIM_VALIDATION") {
        // No claim validation AI call yet — advance immediately.
        // Replace with an AI claim validator when available.
        logger.debug(
          { event: "eval.claim_validation.advance", sessionId },
          "CLAIM_VALIDATION: auto-advancing to EDGE_CASE_QUESTION"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "CLAIM_VALIDATION_MAP") {
        logger.debug(
          { event: "eval.claim_validation_map.advance", sessionId },
          "CLAIM_VALIDATION_MAP: auto-advancing to DEPTH_PROFILE_GEN"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "DEPTH_PROFILE_GEN") {
        logger.debug(
          { event: "eval.depth_profile_gen.advance", sessionId },
          "DEPTH_PROFILE_GEN: auto-advancing to HIRE_SIGNAL_CALC"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      // ── Domain Knowledge — scored states ─────────────────────────────────────

      if (stateName === "CONCEPTUAL_SCORING") {
        const dCtx       = ctx as DomainKnowledgeMachineContext;
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
        // Heuristic until a dedicated conceptual scorer is wired into ai-engine.
        // Phase 1 slice used for flags — replaces old flat field access.
        const misconceptionPenalty = Math.min(0.3, dCtx.phase1.misconceptionsDetected.length * 0.1);
        const confidencePenalty    = dCtx.phase1.overconfidenceFlag ? 0.1 : 0;
        const score                = Math.max(0, 0.8 - misconceptionPenalty - confidencePenalty);
        logger.info(
          {
            event:              "eval.conceptual_scoring.result",
            sessionId,
            score,
            durationMs:         Date.now() - startMs,
            misconceptionCount: dCtx.phase1.misconceptionsDetected.length,
            overconfidence:     dCtx.phase1.overconfidenceFlag,
          },
          `Conceptual score: ${score.toFixed(2)}`
        );
        await sendAndSettle(actor, { type: "CONCEPTUAL_SCORED", score }, sessionId);
        return;
      }

      if (stateName === "DEPTH_SCORING") {
        const dCtx = ctx as DomainKnowledgeMachineContext;
        logger.debug(
          {
            event:           "eval.depth_scoring.start",
            sessionId,
            productionDepth: dCtx.phase2.productionDepthScore,
            inflationFlag:   dCtx.phase2.inflationFlag,
            idkHandled:      dCtx.phase3.idkHandled,
          },
          "Scoring depth answer"
        );
        const startMs = Date.now();
        const base    = dCtx.phase2.productionDepthScore;
        const bonus   = (dCtx.phase3.adjacentDomainTested ? 0.05 : 0) +
                        (dCtx.phase3.idkHandled ? 0.05 : 0);
        const score   = Math.min(1, base + bonus);
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
        const dCtx = ctx as DomainKnowledgeMachineContext;
        logger.debug(
          {
            event:            "eval.d2_scoring.start",
            sessionId,
            crossDomainLinked: dCtx.phase4.crossDomainLinked,
            d2RedirectIssued:  dCtx.phase4.d2RedirectIssued,
          },
          "Scoring domain 2 answer"
        );
        const startMs   = Date.now();
        const base      = dCtx.phase4.crossDomainLinked ? 0.75 : 0.5;
        const penalty   = dCtx.phase4.d2RedirectIssued   ? 0.1  : 0;
        const score     = Math.min(1, Math.max(0, base - penalty));
        const depthType = dCtx.phase4.crossDomainLinked ? ("deep" as const) : ("broad" as const);
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
        const dCtx = ctx as DomainKnowledgeMachineContext;
        logger.debug(
          { event: "eval.stretch_scoring.start", sessionId },
          "Scoring stretch answer"
        );
        const startMs         = Date.now();
        // Heuristic proxy until a dedicated stretch scorer exists.
        const firstPrinciples = Math.min(1, dCtx.phase2.productionDepthScore + 0.1);
        const learning        = dCtx.phase6.coachabilityScore;
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

      // ── Domain Knowledge — terminal pipeline ──────────────────────────────────

      if (stateName === "DOMAIN_SCORE_CALC") {
        const dCtx       = ctx as DomainKnowledgeMachineContext;
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
            event:            "eval.domain_score_calc.start",
            sessionId,
            transcriptLength: transcript.length,
          },
          "Computing dimension scores from DOMAIN_SCORE_CALC state"
        );
        const startMs           = Date.now();
        const scoringTranscript = transcript.map((t) => ({
          role:      t.role,
          content:   t.content,
          phase:     t.phase,
          stateName: t.stateName,
        }));
        const { scores, overall, hireSignal } = await computeDimensionScores(
          session.type,
          scoringTranscript,
          dCtx.domainPlan,
          session.tier
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

      if (stateName === "REPORT_BUILDING" && typeRegistry.get(sessionId) === "domain_knowledge") {
        const dCtx       = ctx as DomainKnowledgeMachineContext;
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
        const startMs           = Date.now();
        const scoringTranscript = transcript.map((t) => ({
          role:      t.role,
          content:   t.content,
          phase:     t.phase,
          stateName: t.stateName,
        }));
        const report = await generateReport(
          session.type,
          sessionId,
          dCtx.dimensionScores,
          dCtx.overallScore ?? 0,
          dCtx.hireSignal   ?? "no_hire",
          scoringTranscript,
          session.tier
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

      if (stateName === "HIRE_SIGNAL_CALC" && typeRegistry.get(sessionId) === "domain_knowledge") {
        // computeHireSignal action already fired on entry — just advance.
        logger.debug(
          { event: "eval.dk.hire_signal.advance", sessionId },
          "DK HIRE_SIGNAL_CALC: advancing to REPORT_BUILDING"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      // ══════════════════════════════════════════════════════════════════════
      // SYSTEM DESIGN — auto-advance and scored states
      // ══════════════════════════════════════════════════════════════════════

      if (stateName === "CLARIFY_STARTED" || stateName === "SOLUTION_JUMPED") {
        logger.debug(
          { event: "eval.sd.clarify_advance", sessionId, stateName },
          `${stateName}: auto-advancing to CLARIFYING`
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "NFR_NUDGE_CHECK") {
        logger.debug(
          { event: "eval.sd.nfr_nudge.advance", sessionId },
          "NFR_NUDGE_CHECK: auto-advancing to SCORING_COVERAGE"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "MATH_VALIDATION") {
        logger.debug(
          { event: "eval.sd.math_validation.advance", sessionId },
          "MATH_VALIDATION: auto-advancing to SCAFFOLDING_CHECK"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "GAP_DETECTION") {
        logger.debug(
          { event: "eval.sd.gap_detection.advance", sessionId },
          "GAP_DETECTION: auto-advancing (machine guard selects PROBE_ISSUE or SCORING)"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "WEAK_POINT_SELECT") {
        logger.debug(
          { event: "eval.sd.weak_point.advance", sessionId },
          "WEAK_POINT_SELECT: auto-advancing to TRADEOFF_CHALLENGE"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "ADAPTATION_SCORING") {
        logger.debug(
          { event: "eval.sd.adaptation_scoring.advance", sessionId },
          "ADAPTATION_SCORING: auto-advancing to SELF_CRITIQUE_PROMPT"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "SELF_AWARENESS_SCORE") {
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
        logger.debug(
          { event: "eval.sd.session_closing.advance", sessionId },
          "SESSION_CLOSING: auto-advancing to DIMENSION_SCORING"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "EVIDENCE_MAPPING") {
        logger.debug(
          { event: "eval.sd.evidence_mapping.advance", sessionId },
          "EVIDENCE_MAPPING: auto-advancing to HIRE_SIGNAL_CALC"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "REQUIREMENT_CONFIRM") {
        // This state transitions on CANDIDATE_READY, not CANDIDATE_RESPONSE.
        logger.debug(
          { event: "eval.sd.requirement_confirm.advance", sessionId },
          "REQUIREMENT_CONFIRM: sending CANDIDATE_READY to advance to ESTIMATING"
        );
        await sendAndSettle(actor, { type: "CANDIDATE_READY" }, sessionId);
        return;
      }

      if (stateName === "TRADEOFF_CHALLENGE" || stateName === "FAILURE_MODE_PROBE") {
        const sdCtx            = ctx as SystemDesignMachineContext;
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
        await sendAndSettle(
          actor,
          {
            type:              "TRADEOFF_RESPONSE",
            response:          { content } as unknown as import("@interview/shared-types").CandidateResponse,
            tradeoffIncrement,
          },
          sessionId
        );
        return;
      }

      if (stateName === "PROBE_RESPONSE_EVAL") {
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

      if (stateName === "SCORING_COVERAGE") {
        const score = Math.min(1, content.length / 800);
        logger.debug(
          { event: "eval.sd.coverage_scored.dispatch", sessionId, score },
          `SCORING_COVERAGE: dispatching COVERAGE_SCORED (score=${score.toFixed(2)})`
        );
        await sendAndSettle(actor, { type: "COVERAGE_SCORED", score }, sessionId);
        return;
      }

      if (stateName === "SCORING_ESTIMATION") {
        const score      = Math.min(1, content.length / 600);
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
        const sdCtx             = ctx as SystemDesignMachineContext;
        const transcript        = transcriptRegistry.get(sessionId) ?? [];
        const session           = await db.query.interviewSessions.findFirst({
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
        const startMs           = Date.now();
        const scoringTranscript = transcript.map((t) => ({
          role: t.role, content: t.content, phase: t.phase, stateName: t.stateName,
        }));
        const { scores, overall } = await computeDimensionScores(
          session.type, scoringTranscript, sdCtx.interviewObject as never ?? [], session.tier
        );
        logger.info(
          { event: "eval.sd.dimension_scoring.result", sessionId, durationMs: Date.now() - startMs, overall },
          `SD scores computed: overall=${overall.toFixed(3)}`
        );
        await sendAndSettle(actor, { type: "SCORE_COMPUTED", scores, overall }, sessionId);
        return;
      }

      if (stateName === "HIRE_SIGNAL_CALC" && typeRegistry.get(sessionId) === "system_design") {
        logger.debug(
          { event: "eval.sd.hire_signal.advance", sessionId },
          "SD HIRE_SIGNAL_CALC: advancing to REPORT_GENERATED"
        );
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "REPORT_GENERATED") {
        const sdCtx             = ctx as SystemDesignMachineContext;
        const transcript        = transcriptRegistry.get(sessionId) ?? [];
        const session           = await db.query.interviewSessions.findFirst({
          where:   eq(interviewSessions.id, sessionId),
          columns: { type: true, tier: true },
        });
        if (!session) {
          logger.error({ event: "eval.sd.report.no_session", sessionId }, "Session not found");
          return;
        }
        logger.info({ event: "eval.sd.report.start", sessionId }, "Generating SD report");
        const startMs           = Date.now();
        const scoringTranscript = transcript.map((t) => ({
          role: t.role, content: t.content, phase: t.phase, stateName: t.stateName,
        }));
        const report = await generateReport(
          session.type, sessionId,
          sdCtx.dimensionScores, sdCtx.overallScore ?? 0,
          sdCtx.hireSignal       ?? "no_hire",
          scoringTranscript, session.tier
        );
        logger.info(
          { event: "eval.sd.report.result", sessionId, durationMs: Date.now() - startMs },
          "SD report generated"
        );
        await sendAndSettle(actor, { type: "REPORT_GENERATED", report } as never, sessionId);
        return;
      }

      // ══════════════════════════════════════════════════════════════════════
      // BEHAVIORAL — eval branches
      // ══════════════════════════════════════════════════════════════════════

      if (stateName === "STRUCTURE_DETECT") {
        logger.debug({ event: "eval.beh.structure_detect.advance", sessionId }, "STRUCTURE_DETECT: auto-advancing to ATTRIBUTION_CHECK");
        await sendAndSettle(actor, { type: "PHASE_COMPLETE" }, sessionId);
        return;
      }

      if (stateName === "FALLBACK_PROMPT") {
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

      if (stateName === "FOLLOW_UP_PROBING_1") {
        logger.debug(
          { event: "eval.beh.follow_up_probing.advance", sessionId },
          "FOLLOW_UP_PROBING_1: sending PROBE_RESPONSE (machine guards select next state)"
        );
        await sendAndSettle(actor, { type: "PROBE_RESPONSE" }, sessionId);
        return;
      }

      if (stateName === "BASELINE_QUESTION") {
        const wordCount     = content.split(/\s+/).length;
        const baselineScore = {
          structure:      Math.min(1, wordCount / 100),
          quantification: content.match(/\d+%|\d+ times|\d+ years/g)?.length ? 0.7 : 0.3,
          iWeRatio:       0.5,
        };
        logger.debug(
          { event: "eval.beh.baseline_scored.dispatch", sessionId, baselineScore },
          "BASELINE_QUESTION: dispatching BASELINE_SCORED"
        );
        await sendAndSettle(actor, { type: "BASELINE_SCORED", score: baselineScore }, sessionId);
        return;
      }

      if (stateName === "CALIBRATE_INTENSITY") {
        const bCtx      = ctx as BehavioralMachineContext;
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
        const score: import("@interview/shared-types").InfluenceScore = {
          scopeLevel:             2,
          stakeholderSpecificity: 0.5,
          frictionHandled:        false,
          businessOutcome:        false,
        };
        logger.debug(
          { event: "eval.beh.influence_scoring.dispatch", sessionId, score },
          "INFLUENCE_SCORING: dispatching INFLUENCE_SCORED"
        );
        await sendAndSettle(actor, { type: "INFLUENCE_SCORED", score }, sessionId);
        return;
      }

      if (stateName === "AUTHENTICITY_FLAGS") {
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
        const bCtx              = ctx as BehavioralMachineContext;
        const transcript        = transcriptRegistry.get(sessionId) ?? [];
        const session           = await db.query.interviewSessions.findFirst({
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
        const startMs           = Date.now();
        const scoringTranscript = transcript.map((t) => ({
          role: t.role, content: t.content, phase: t.phase, stateName: t.stateName,
        }));
        const { scores, overall } = await computeDimensionScores(
          session.type, scoringTranscript, bCtx.competencyPlan, session.tier
        );
        logger.info(
          { event: "eval.beh.hire_signal.result", sessionId, durationMs: Date.now() - startMs, overall },
          `Behavioral scores computed: overall=${overall.toFixed(3)}`
        );
        await sendAndSettle(actor, { type: "SCORE_COMPUTED", scores, overall }, sessionId);
        return;
      }

      if (stateName === "REPORT_BUILDING" && typeRegistry.get(sessionId) === "behavioral") {
        const bCtx              = ctx as BehavioralMachineContext;
        const transcript        = transcriptRegistry.get(sessionId) ?? [];
        const session           = await db.query.interviewSessions.findFirst({
          where:   eq(interviewSessions.id, sessionId),
          columns: { type: true, tier: true },
        });
        if (!session) {
          logger.error({ event: "eval.beh.report.no_session", sessionId }, "Session not found");
          return;
        }
        logger.info({ event: "eval.beh.report.start", sessionId }, "Generating behavioral report");
        const startMs           = Date.now();
        const scoringTranscript = transcript.map((t) => ({
          role: t.role, content: t.content, phase: t.phase, stateName: t.stateName,
        }));
        const report = await generateReport(
          session.type, sessionId,
          bCtx.dimensionScores, bCtx.overallScore ?? 0,
          bCtx.hireSignal       ?? "no_hire",
          scoringTranscript, session.tier
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
    actor:     AnyActor,
    userId:    string
  ): Promise<void> {
    const finalizeStart = Date.now();
    logger.info(
      { event: "finalize.start", sessionId, userId },
      "Session finalization started"
    );

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

    logger.info(
      {
        event:            "finalize.scoring.start",
        sessionId,
        type:             session.type,
        tier:             session.tier,
        transcriptLength: scoringTranscript.length,
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

    if (result.scores.length > 0) {
      await db.insert(dimensionScores).values(
        result.scores.map((s) => ({
          sessionId,
          dimension:         s.dimension,
          score:             s.score,
          evidence:          s.evidence,
          transcriptIndices: s.transcriptIndices,
        }))
      );
    } else {
      logger.warn(
        { event: "finalize.scores.empty", sessionId },
        "No dimension scores returned — skipping insert"
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

    // ── Update user aggregates ─────────────────────────────────────────────
    // Read current values first to compute the running average in TypeScript.
    // The previous SQL expression divided by (completed_sessions+1) while also
    // incrementing in the same query, producing a wrong denominator.
    const existingAgg  = await db.query.userInterviewAggregates.findFirst({
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

    // ── Clean up in-memory registries ──────────────────────────────────────
    actorRegistry.delete(sessionId);
    transcriptRegistry.delete(sessionId);
    typeRegistry.delete(sessionId);

    logger.info(
      {
        event:                   "finalize.complete",
        sessionId,
        userId,
        hireSignal:              result.hireSignal,
        overallScore:            result.overall,
        totalDurationMs:         Date.now() - finalizeStart,
        remainingActiveSessions: actorRegistry.size,
      },
      `Session finalized in ${Date.now() - finalizeStart}ms — signal=${result.hireSignal}, score=${result.overall.toFixed(3)}`
    );
  }

  // ─── HELPERS ───────────────────────────────────────────────

  static snapToStateName(snap: AnyMachineSnapshot): string {
    return snapToStateName(snap);
  }

  /**
   * Build a plan context string for the current interview state.
   * Passed to generateInterviewerResponse so the AI knows which
   * question/domain/competency is active.
   */
  private static buildPlanContext(ctx: AnyContext): string {
    // System design — use activeProbeIndex, not always questions[0]
    if (ctx.interviewObject?.questions) {
      const idx = Math.min(ctx.activeProbeIndex ?? 0, ctx.interviewObject.questions.length - 1);
      const q   = ctx.interviewObject.questions[idx];
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
    // Domain knowledge — variable-length plan; expose all question types for the active domain.
    const dCtx = ctx as DomainKnowledgeMachineContext;
    if (Array.isArray(dCtx.domainPlan) && dCtx.domainPlan.length > 0) {
      const domainIndex = Math.min(dCtx.currentDomain ?? 0, dCtx.domainPlan.length - 1);
      const item        = dCtx.domainPlan[domainIndex];
      if (!item) return "";
      return [
        `Domain ${domainIndex + 1} of ${dCtx.domainPlan.length}: ${item.domain}`,
        `Context mode: ${dCtx.planContextMode}`,
        `Conceptual Q: ${item.questions.conceptual}`,
        `Applied Q: ${item.questions.applied}`,
        `Edge case Q: ${item.questions.edgeCase}`,
      ].join("\n");
    }
    return "";
  }

  /**
   * Build a resume evidence map for the active domain.
   *
   * This is passed to generateInterviewerResponse so the AI can tie
   * follow-up probes back to specific resume claims rather than asking
   * generic questions.  For non-domain-knowledge interviews the map is
   * always empty (the transcript already carries all relevant context).
   *
   * Shape: { [domainName: string]: string[] } — each value is an array
   * of resume bullet-points or sentences that mention that domain.
   */
  private static buildResumeEvidence(ctx: AnyContext): Record<string, string[]> {
    const dCtx = ctx as DomainKnowledgeMachineContext;
    if (!Array.isArray(dCtx.domainPlan) || dCtx.domainPlan.length === 0) return {};

    const evidence: Record<string, string[]> = {};
    for (const item of dCtx.domainPlan) {
      // DomainPlan.resumeEvidence is an optional string[] added by the adaptive
      // planner in generateDomainPlan.  Fall back to an empty array if the
      // planner ran in exploratory mode and couldn't map resume lines.
      evidence[item.domain] = (item as DomainPlan & { resumeEvidence?: string[] }).resumeEvidence ?? [];
    }
    return evidence;
  }

  /**
   * Enriches the planContext string with planContextMode and per-domain
   * resumeEvidence so the AI interviewer has full signal for adaptive
   * follow-ups without requiring InterviewerContext to be extended.
   *
   * When @interview/ai-engine adds typed planContextMode / resumeEvidence
   * fields to InterviewerContext, callers can drop this helper and pass the
   * fields directly.
   */
  private static enrichPlanContext(planContext: string, ctx: AnyContext): string {
    const dCtx = ctx as DomainKnowledgeMachineContext;
    if (!Array.isArray(dCtx.domainPlan) || dCtx.domainPlan.length === 0) {
      return planContext;
    }

    const mode     = dCtx.planContextMode ?? "exploratory";
    const evidence = InterviewSessionController.buildResumeEvidence(ctx);
    const evidenceLines = Object.entries(evidence)
      .filter(([, bullets]) => bullets.length > 0)
      .map(([domain, bullets]) =>
        `Resume evidence — ${domain}:\n${bullets.map((b) => `  • ${b}`).join("\n")}`
      )
      .join("\n");

    return [
      planContext,
      `Plan context mode: ${mode}`,
      evidenceLines,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private static classifyMsgType(stateName: string): MessageType {
    const s = stateName.toLowerCase();
    if (s.includes("probe")    || s.includes("follow_up")) return "probe";
    if (s.includes("redirect"))                             return "redirect";
    if (s.includes("nudge")    || s.includes("silence"))   return "nudge";
    if (s.includes("clos")     || s.includes("wrap"))      return "summary";
    if (s.includes("clarif"))                               return "clarification";
    return "question";
  }

  /**
   * Returns the pre-generated opening question for a session, then removes
   * it from the registry so it is only delivered once (on first WS connect).
   * Returns null if no opening message is pending (already consumed, or
   * generation failed during pre-session).
   */
  static consumeOpeningMessage(sessionId: string): string | null {
    const msg = openingMessageRegistry.get(sessionId) ?? null;
    if (msg !== null) {
      openingMessageRegistry.delete(sessionId);
      logger.debug(
        { event: "opening_message.consumed", sessionId },
        "Opening message consumed from registry"
      );
    }
    return msg;
  }

  static async persistMsg(
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