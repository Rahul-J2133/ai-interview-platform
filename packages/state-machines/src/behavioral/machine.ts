import { setup, assign, type ActorRefFrom } from "xstate";
import type {
  BehavioralContext as BCtx,
  CompetencyPlan,
  StarScore,
  AdversityScore,
  InfluenceScore,
  AuthenticityFlag,
  InterviewReport,
  DimensionScore,
  HireSignal,
} from "@interview/shared-types";
import {
  type SharedContext,
  SHARED_ACTION_IMPLS,
  sharedGuards,
  calcHireSignal,
  PHASE_BUDGETS_MS,
} from "../shared/index.js";

// ============================================================
// CONTEXT
// ============================================================

export interface BehavioralMachineContext extends SharedContext {
  competencyPlan: CompetencyPlan[];
  levelFlag: "junior" | "mid" | "senior" | "staff" | "principal";
  followUpIntensity: "hard" | "medium" | "scaffolded";

  // Attribution flag is its own variable
  attributionFlag: boolean;
  iWeRatioRaw: number; // 0-1, 1 = all "I"

  // Phase 2-4: Per-competency state
  currentCompetencyIndex: number;
  starScores: StarScore[];
  activeProbeIndex: number;

  // Phase 3
  adversityScore: AdversityScore | null;
  storyExistenceConfirmed: boolean;
  fallbackPromptIssued: boolean;

  // Phase 4
  influenceScore: InfluenceScore | null;

  // Phase 5
  authenticityFlags: AuthenticityFlag[];

  // Result depth probe tracking
  resultDepthProbed: boolean[];

  // Baseline
  baselineScore: {
    structure: number;
    quantification: number;
    iWeRatio: number;
  } | null;
}

// ============================================================
// EVENTS
// ============================================================

type BEvent =
  | { type: "START_SESSION" }
  | { type: "INPUTS_PARSED" }
  | { type: "PLAN_GENERATED"; plan: CompetencyPlan[] }
  | { type: "QUALITY_GATE_PASS" }
  | { type: "QUALITY_GATE_FAIL" }
  | { type: "CANDIDATE_READY" }
  | { type: "CANDIDATE_RESPONSE"; content: string; iWeRatio?: number }
  | { type: "BASELINE_SCORED"; score: BehavioralMachineContext["baselineScore"] }
  | { type: "ATTRIBUTION_CHECK_COMPLETE"; hasFlag: boolean; ratio: number }
  | { type: "INTENSITY_CALIBRATED"; intensity: "hard" | "medium" | "scaffolded" }
  | { type: "STAR_PARSED"; partial: Partial<StarScore> }
  | { type: "RESULT_WEAK" }
  | { type: "RESULT_DEPTH_PROBED" }
  | { type: "PROBE_RESPONSE" }
  | { type: "STORY_EXISTS"; exists: boolean }
  | { type: "FALLBACK_PROMPT_ISSUED" }
  | { type: "ADVERSITY_SCORED"; score: AdversityScore }
  | { type: "INFLUENCE_SCORED"; score: InfluenceScore }
  | { type: "AUTHENTICITY_FLAGS_SET"; flags: AuthenticityFlag[] }
  | { type: "TIMEOUT" }
  | { type: "PHASE_COMPLETE" }
  | { type: "SCORE_COMPUTED"; scores: DimensionScore[]; overall: number }
  | { type: "REPORT_READY"; report: InterviewReport }
  | { type: "ERROR"; message: string };

// ============================================================
// INPUT
// ============================================================

export interface BehavioralMachineInput {
  sessionId: string;
  userId: string;
  role: string;
  tier: "T1" | "T2" | "T3";
  level: "junior" | "mid" | "senior" | "staff" | "principal";
}

// ============================================================
// MACHINE
// ============================================================

export const behavioralMachine = setup({
  types: {
    context: {} as BehavioralMachineContext,
    events: {} as BEvent,
    input: {} as BehavioralMachineInput,
  },

  actions: {
    // ── Shared actions: re-wrapped in assign() so XState binds them to
    //    BehavioralMachineContext, satisfying the variance probe.
    incrementExchanges:          assign(SHARED_ACTION_IMPLS.incrementExchanges),
    incrementSilenceEvents:      assign(SHARED_ACTION_IMPLS.incrementSilenceEvents),
    incrementProbeCount:         assign(SHARED_ACTION_IMPLS.incrementProbeCount),
    incrementRedirectCount:      assign(SHARED_ACTION_IMPLS.incrementRedirectCount),
    incrementQualityGateRetries: assign(SHARED_ACTION_IMPLS.incrementQualityGateRetries),
    advancePhase:                assign(SHARED_ACTION_IMPLS.advancePhase),
    clearError:                  assign(SHARED_ACTION_IMPLS.clearError),

    // ── Machine-specific actions ──────────────────────────────

    // Inline in COMPETENCY_PLAN_GEN transition; kept here for any direct use
    setCompetencyPlan: assign({
      competencyPlan: ({ event }) => {
        const e = event as Extract<BEvent, { type: "PLAN_GENERATED" }>;
        return e.plan;
      },
    }),

    setPlanAndAllocateStarSlots: assign({
      competencyPlan: ({ event }) => {
        const e = event as Extract<BEvent, { type: "PLAN_GENERATED" }>;
        return e.plan;
      },
      // Pre-allocate one StarScore slot per competency
      starScores: ({ event }) => {
        const e = event as Extract<BEvent, { type: "PLAN_GENERATED" }>;
        return e.plan.map((p) => ({
          competency: p.competency,
          situation: 0,
          task: 0,
          action: 0,
          result: 0,
          learning: undefined,
          scopeMatch: false,
          resultDepthProbed: false,
        }));
      },
    }),

    setBaselineScore: assign({
      baselineScore: ({ event }) => {
        const e = event as Extract<BEvent, { type: "BASELINE_SCORED" }>;
        return e.score;
      },
    }),

    setAttributionFlag: assign({
      attributionFlag: ({ event }) => {
        const e = event as Extract<BEvent, { type: "ATTRIBUTION_CHECK_COMPLETE" }>;
        return e.hasFlag;
      },
      iWeRatioRaw: ({ event }) => {
        const e = event as Extract<BEvent, { type: "ATTRIBUTION_CHECK_COMPLETE" }>;
        return e.ratio;
      },
    }),

    setFollowUpIntensity: assign({
      followUpIntensity: ({ event }) => {
        const e = event as Extract<BEvent, { type: "INTENSITY_CALIBRATED" }>;
        return e.intensity;
      },
    }),

    recordStarScore: assign({
      starScores: ({ context, event }) => {
        const e = event as Extract<BEvent, { type: "STAR_PARSED" }>;
        return context.starScores.map((s, i) =>
          i === context.currentCompetencyIndex ? { ...s, ...e.partial } : s
        );
      },
    }),

    advanceProbe: assign({
      activeProbeIndex: ({ context }) => context.activeProbeIndex + 1,
      probeCount: ({ context }) => context.probeCount + 1,
    }),

    markResultDepthProbed: assign({
      resultDepthProbed: ({ context }) => {
        const updated = [...context.resultDepthProbed];
        updated[context.currentCompetencyIndex] = true;
        return updated;
      },
    }),

    setAdversityScore: assign({
      adversityScore: ({ event }) => {
        const e = event as Extract<BEvent, { type: "ADVERSITY_SCORED" }>;
        return e.score;
      },
    }),

    setInfluenceScore: assign({
      influenceScore: ({ event }) => {
        const e = event as Extract<BEvent, { type: "INFLUENCE_SCORED" }>;
        return e.score;
      },
    }),

    setAuthenticityFlags: assign({
      authenticityFlags: ({ event }) => {
        const e = event as Extract<BEvent, { type: "AUTHENTICITY_FLAGS_SET" }>;
        return e.flags;
      },
    }),

    advanceCompetency: assign({
      currentCompetencyIndex: ({ context }) => context.currentCompetencyIndex + 1,
      activeProbeIndex: 0, // Reset probe counter per competency
    }),

    markStoryExistence: assign({
      storyExistenceConfirmed: ({ event }) => {
        const e = event as Extract<BEvent, { type: "STORY_EXISTS" }>;
        return e.exists;
      },
    }),

    markFallbackPromptIssued: assign({ fallbackPromptIssued: true }),

    setDimensionScores: assign({
      dimensionScores: ({ event }) => {
        const e = event as Extract<BEvent, { type: "SCORE_COMPUTED" }>;
        return e.scores;
      },
      overallScore: ({ event }) => {
        const e = event as Extract<BEvent, { type: "SCORE_COMPUTED" }>;
        return e.overall;
      },
    }),

    setReport: assign({
      report: ({ event }) => {
        const e = event as Extract<BEvent, { type: "REPORT_READY" }>;
        return e.report;
      },
    }),

    computeHireSignal: assign({
      hireSignal: ({ context }) =>
        calcHireSignal(context.overallScore ?? 0, context.tier) as HireSignal,
    }),
  },

  guards: {
    // Shared guards are plain predicate functions — spread directly.
    ...sharedGuards,

    probesBudgetRemaining: ({ context }) => context.activeProbeIndex < 3,

    // Named guard replacing the inline `({ event }) => event.exists` form.
    // Inline arrow guards inside transition arrays are not valid in XState v5
    // setup() — guards must be registered here and referenced by name.
    storyExists: ({ event }) => {
      const e = event as Extract<BEvent, { type: "STORY_EXISTS" }>;
      return e.exists;
    },

    storyDoesNotExist: ({ context }) => !context.storyExistenceConfirmed,

    fallbackAlsoFailed: ({ context }) =>
      !context.storyExistenceConfirmed && context.fallbackPromptIssued,

    hasAuthenticityFlags: ({ context }) => context.authenticityFlags.length > 0,

    moreCompetenciesRemain: ({ context }) =>
      context.currentCompetencyIndex < context.competencyPlan.length - 1,
  },
}).createMachine({
  id: "behavioral",
  initial: "IDLE",

  context: ({ input }) => ({
    sessionId: input.sessionId,
    userId: input.userId,
    role: input.role,
    tier: input.tier,
    level: input.level,
    phase: 0,
    stateName: "IDLE",
    silenceTimerMs: 15_000,
    qualityGateRetries: 0,
    totalExchanges: 0,
    silenceEvents: 0,
    probeCount: 0,
    redirectCount: 0,
    errorMessage: null,
    dimensionScores: [],
    hireSignal: null,
    overallScore: null,
    report: null,
    competencyPlan: [],
    levelFlag: input.level,
    followUpIntensity: "medium" as const,
    attributionFlag: false,
    iWeRatioRaw: 0.5,
    currentCompetencyIndex: 0,
    starScores: [],
    activeProbeIndex: 0,
    adversityScore: null,
    storyExistenceConfirmed: false,
    fallbackPromptIssued: false,
    influenceScore: null,
    authenticityFlags: [],
    resultDepthProbed: [false, false, false],
    baselineScore: null,
  }),

  states: {
    IDLE: {
      entry: assign({ stateName: "IDLE" }),
      on: { START_SESSION: "PARSING_RESUME" },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 0 — Pre-session competency mapping
    // ──────────────────────────────────────────────────────────
    PARSING_RESUME: {
      entry: assign({ stateName: "PARSING_RESUME", phase: 0 }),
      on: {
        INPUTS_PARSED: "JD_COMPETENCY_MAP",
        ERROR: "ERROR_STATE",
      },
    },

    JD_COMPETENCY_MAP: {
      entry: assign({ stateName: "JD_COMPETENCY_MAP" }),
      on: { PHASE_COMPLETE: "COMPETENCY_PLAN_GEN" },
    },

    COMPETENCY_PLAN_GEN: {
      entry: assign({ stateName: "COMPETENCY_PLAN_GEN" }),
      on: {
        PLAN_GENERATED: {
          target: "QUALITY_GATE",
          // Single action allocates both competencyPlan and starScores atomically
          actions: "setPlanAndAllocateStarSlots",
        },
      },
    },

    QUALITY_GATE: {
      entry: assign({ stateName: "QUALITY_GATE" }),
      on: {
        QUALITY_GATE_PASS: "PLAN_READY",
        QUALITY_GATE_FAIL: [
          {
            guard: "qualityGateMaxRetriesReached",
            target: "PLAN_READY",
            actions: "incrementQualityGateRetries",
          },
          {
            target: "COMPETENCY_PLAN_GEN",
            actions: "incrementQualityGateRetries",
          },
        ],
      },
    },

    PLAN_READY: {
      entry: assign({ stateName: "PLAN_READY" }),
      on: { CANDIDATE_READY: "CONTEXT_SETTING" },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 1 — Opening & warm-up
    // ──────────────────────────────────────────────────────────
    CONTEXT_SETTING: {
      entry: assign({ stateName: "CONTEXT_SETTING", phase: 1 }),
      on: { CANDIDATE_RESPONSE: "BASELINE_QUESTION" },
    },

    BASELINE_QUESTION: {
      entry: assign({ stateName: "BASELINE_QUESTION" }),
      after: {
        [PHASE_BUDGETS_MS.behavioral[1]]: "CALIBRATE_INTENSITY",
      },
      on: {
        BASELINE_SCORED: {
          target: "STRUCTURE_DETECT",
          actions: "setBaselineScore",
        },
        TIMEOUT: "CALIBRATE_INTENSITY",
      },
    },

    STRUCTURE_DETECT: {
      entry: assign({ stateName: "STRUCTURE_DETECT" }),
      on: { PHASE_COMPLETE: "ATTRIBUTION_CHECK" },
    },

    ATTRIBUTION_CHECK: {
      entry: assign({ stateName: "ATTRIBUTION_CHECK" }),
      on: {
        ATTRIBUTION_CHECK_COMPLETE: {
          target: "CALIBRATE_INTENSITY",
          actions: "setAttributionFlag",
        },
      },
    },

    CALIBRATE_INTENSITY: {
      entry: assign({ stateName: "CALIBRATE_INTENSITY" }),
      on: {
        INTENSITY_CALIBRATED: {
          target: "DELIVERING_Q1",
          actions: "setFollowUpIntensity",
        },
      },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 2 — Competency probe 1 (primary gap)
    // ──────────────────────────────────────────────────────────
    DELIVERING_Q1: {
      entry: assign({ stateName: "DELIVERING_Q1", phase: 2, activeProbeIndex: 0 }),
      on: { CANDIDATE_RESPONSE: "STAR_PARSING_LIVE_1" },
    },

    STAR_PARSING_LIVE_1: {
      entry: assign({ stateName: "STAR_PARSING_LIVE_1" }),
      on: {
        // Accumulate STAR components; stay in state until signalled out
        STAR_PARSED: {
          target: "STAR_PARSING_LIVE_1",
          actions: "recordStarScore",
        },
        RESULT_WEAK: "RESULT_DEPTH_PROBE_1",
        PHASE_COMPLETE: "FOLLOW_UP_PROBING_1",
      },
    },

    RESULT_DEPTH_PROBE_1: {
      entry: [
        "markResultDepthProbed",
        assign({ stateName: "RESULT_DEPTH_PROBE_1" }),
      ],
      on: {
        CANDIDATE_RESPONSE: "FOLLOW_UP_PROBING_1",
        RESULT_DEPTH_PROBED: "FOLLOW_UP_PROBING_1",
      },
    },

    FOLLOW_UP_PROBING_1: {
      entry: [
        "incrementProbeCount",
        assign({ stateName: "FOLLOW_UP_PROBING_1" }),
      ],
      on: {
        PROBE_RESPONSE: [
          {
            guard: "probesBudgetRemaining",
            target: "FOLLOW_UP_PROBING_1",
            actions: "advanceProbe",
          },
          { target: "SCOPE_VALIDATION_1" },
        ],
      },
    },

    SCOPE_VALIDATION_1: {
      entry: assign({ stateName: "SCOPE_VALIDATION_1" }),
      on: { PHASE_COMPLETE: "ADVERSITY_QUESTION" },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 3 — Competency probe 2 (adversity)
    // ──────────────────────────────────────────────────────────
    ADVERSITY_QUESTION: {
      entry: assign({ stateName: "ADVERSITY_QUESTION", phase: 3, activeProbeIndex: 0 }),
      after: {
        [PHASE_BUDGETS_MS.behavioral[3]]: "ADVERSITY_SCORING",
      },
      on: {
        CANDIDATE_RESPONSE: "STORY_EXISTENCE_CHECK",
        TIMEOUT: "ADVERSITY_SCORING",
      },
    },

    STORY_EXISTENCE_CHECK: {
      entry: assign({ stateName: "STORY_EXISTENCE_CHECK" }),
      on: {
        STORY_EXISTS: [
          {
            // Story confirmed → proceed to language analysis
            guard: "storyExists",
            target: "NEG_LANGUAGE_DETECT",
            actions: "markStoryExistence",
          },
          {
            // No story → offer a fallback prompt
            target: "FALLBACK_PROMPT",
            actions: "markStoryExistence",
          },
        ],
      },
    },

    FALLBACK_PROMPT: {
      entry: [
        "markFallbackPromptIssued",
        assign({ stateName: "FALLBACK_PROMPT" }),
      ],
      // If fallback also fails (storyExistenceConfirmed still false after
      // the prompt was issued) move directly to scoring via always transition.
      // The always check runs AFTER entry actions settle, so fallbackPromptIssued
      // is guaranteed true by the time the guard evaluates.
      always: {
        guard: "fallbackAlsoFailed",
        target: "ADVERSITY_SCORING",
      },
      on: {
        // Candidate responds to fallback → re-check story existence
        CANDIDATE_RESPONSE: "STORY_EXISTENCE_CHECK",
      },
    },

    NEG_LANGUAGE_DETECT: {
      entry: assign({ stateName: "NEG_LANGUAGE_DETECT" }),
      on: { PHASE_COMPLETE: "ACCOUNTABILITY_PROBE" },
    },

    ACCOUNTABILITY_PROBE: {
      entry: assign({ stateName: "ACCOUNTABILITY_PROBE" }),
      on: { CANDIDATE_RESPONSE: "ADVERSITY_SCORING" },
    },

    ADVERSITY_SCORING: {
      entry: assign({ stateName: "ADVERSITY_SCORING" }),
      on: {
        ADVERSITY_SCORED: {
          target: "INFLUENCE_QUESTION",
          actions: "setAdversityScore",
        },
      },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 4 — Competency probe 3 (scope & influence)
    // ──────────────────────────────────────────────────────────
    INFLUENCE_QUESTION: {
      entry: assign({ stateName: "INFLUENCE_QUESTION", phase: 4, activeProbeIndex: 0 }),
      after: {
        [PHASE_BUDGETS_MS.behavioral[4]]: "INFLUENCE_SCORING",
      },
      on: {
        CANDIDATE_RESPONSE: "SCOPE_LADDER_CLASSIFY",
        TIMEOUT: "INFLUENCE_SCORING",
      },
    },

    SCOPE_LADDER_CLASSIFY: {
      entry: assign({ stateName: "SCOPE_LADDER_CLASSIFY" }),
      on: { PHASE_COMPLETE: "STAKEHOLDER_PROBE" },
    },

    STAKEHOLDER_PROBE: {
      entry: [
        "incrementProbeCount",
        assign({ stateName: "STAKEHOLDER_PROBE" }),
      ],
      on: { CANDIDATE_RESPONSE: "INFLUENCE_SCORING" },
    },

    INFLUENCE_SCORING: {
      entry: assign({ stateName: "INFLUENCE_SCORING" }),
      on: {
        INFLUENCE_SCORED: {
          target: "STORY_OVERLAP_CHECK",
          actions: "setInfluenceScore",
        },
      },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 5 — Anti-gaming & authenticity checks
    // ──────────────────────────────────────────────────────────
    STORY_OVERLAP_CHECK: {
      entry: assign({ stateName: "STORY_OVERLAP_CHECK", phase: 5 }),
      on: { PHASE_COMPLETE: "DETAIL_CONSISTENCY" },
    },

    DETAIL_CONSISTENCY: {
      entry: assign({ stateName: "DETAIL_CONSISTENCY" }),
      on: { PHASE_COMPLETE: "SPECIFICITY_TEST" },
    },

    SPECIFICITY_TEST: {
      entry: assign({ stateName: "SPECIFICITY_TEST" }),
      on: { PHASE_COMPLETE: "AUTHENTICITY_FLAGS" },
    },

    // Flags are soft — both paths converge on scoring regardless
    AUTHENTICITY_FLAGS: {
      entry: assign({ stateName: "AUTHENTICITY_FLAGS" }),
      on: {
        AUTHENTICITY_FLAGS_SET: {
          target: "PER_COMPETENCY_SCORE",
          actions: "setAuthenticityFlags",
        },
      },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 6 — Scoring & STAR-L report
    // ──────────────────────────────────────────────────────────
    PER_COMPETENCY_SCORE: {
      entry: assign({ stateName: "PER_COMPETENCY_SCORE", phase: 6 }),
      on: { PHASE_COMPLETE: "STAR_L_COVERAGE" },
    },

    STAR_L_COVERAGE: {
      entry: assign({ stateName: "STAR_L_COVERAGE" }),
      on: { PHASE_COMPLETE: "HIRE_SIGNAL_CALC" },
    },

    HIRE_SIGNAL_CALC: {
      entry: assign({ stateName: "HIRE_SIGNAL_CALC" }),
      on: {
        SCORE_COMPUTED: {
          target: "REPORT_BUILDING",
          actions: [
            "setDimensionScores",
            "computeHireSignal",
          ],
        },
      },
    },

    // Named REPORT_BUILDING (not REPORT_GENERATED) to avoid collision
    // with the REPORT_READY event type.
    REPORT_BUILDING: {
      entry: assign({ stateName: "REPORT_BUILDING" }),
      on: {
        REPORT_READY: {
          target: "TERMINAL_COMPLETED",
          actions: "setReport",
        },
      },
    },

    TERMINAL_COMPLETED: {
      type: "final" as const,
      entry: assign({ stateName: "TERMINAL_COMPLETED" }),
    },

    ERROR_STATE: {
      type: "final" as const,
      entry: assign({ stateName: "ERROR_STATE" }),
    },
  },
});

export type BehavioralMachine = typeof behavioralMachine;
export type BehavioralActor = ActorRefFrom<BehavioralMachine>;