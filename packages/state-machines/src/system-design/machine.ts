import { setup, assign, type ActorRefFrom } from "xstate";
import type {
  SystemDesignContext as SdCtx,
  InterviewPlan,
  CandidateResponse,
  DimensionScore,
  HireSignal,
  InterviewReport,
} from "@interview/shared-types";
import {
  SharedContext,
  SHARED_ACTION_IMPLS,
  sharedGuards,
  calcHireSignal,
  SILENCE_THRESHOLD_MS,
  PHASE_BUDGETS_MS,
} from "../shared/index.js";

// ============================================================
// CONTEXT
// ============================================================

export interface SystemDesignMachineContext extends SharedContext {
  interviewObject: InterviewPlan | null;
  silenceNudgeIssued: boolean;
  firstMoveFlag: "CLARIFY" | "JUMP" | null;
  reqCoverageScore: number;
  weakNfrFlag: boolean;
  estimationScore: number;
  estimationHintIssued: boolean;
  componentCoverage: number;
  probeHistory: SdCtx["probeHistory"];
  activeProbeIndex: number;
  tradeoffScore: number;
  collaborationSignal: SdCtx["collaborationSignal"];
  negativeCollabFlag: boolean;
  failureModeChallenged: boolean;
  scaleStressTested: boolean;
  selfAwarenessScore: 0 | 0.5 | 1;
  problemNavPenalty: boolean;
}

// ============================================================
// EVENTS
// ============================================================

type SdEvent =
  | { type: "START_SESSION" }
  | { type: "INPUTS_PARSED" }
  | { type: "PLAN_GENERATED"; plan: InterviewPlan }
  | { type: "QUALITY_GATE_PASS" }
  | { type: "QUALITY_GATE_FAIL" }
  | { type: "CANDIDATE_READY" }
  | { type: "CANDIDATE_RESPONSE"; response: CandidateResponse }
  | { type: "TRADEOFF_RESPONSE"; response: CandidateResponse; tradeoffIncrement: number }
  | { type: "SILENCE_DETECTED" }
  | { type: "FIRST_MOVE_CLARIFY" }
  | { type: "FIRST_MOVE_JUMP" }
  | { type: "TIMEOUT" }
  | { type: "PROBE_ISSUED" }
  | { type: "PROBE_BUDGET_EXHAUSTED" }
  | { type: "PHASE_COMPLETE"; score?: number; hintIssued?: boolean; selfAwarenessScore?: 0 | 0.5 | 1 }
  | { type: "PROBE_EVALUATED"; response: "acknowledged_explained" | "defensive" | "partial"; score: number }
  | { type: "COVERAGE_SCORED"; score: number }
  | { type: "ESTIMATION_SCORED"; score: number; hintIssued: boolean }
  | { type: "COMPONENT_COVERAGE_SCORED"; coverage: number }
  | { type: "SESSION_COMPLETE" }
  | { type: "SCORE_COMPUTED"; scores: DimensionScore[]; overall: number }
  | { type: "REPORT_GENERATED"; report: InterviewReport }
  | { type: "ERROR"; message: string };

type SdInput = {
  sessionId: string;
  userId: string;
  role: string;
  tier: "T1" | "T2" | "T3";
  level: "junior" | "mid" | "senior" | "staff" | "principal";
};

// ============================================================
// SETUP
//
// All assign() calls live inside this setup() block so XState
// resolves TContext=SystemDesignMachineContext and TEvent=SdEvent
// correctly. Shared action bodies are imported from SHARED_ACTION_IMPLS
// and wrapped in assign() here — the only pattern that satisfies
// XState v5's _out_TEvent variance probe.
// ============================================================

const sd = setup({
  types: {
    context: {} as SystemDesignMachineContext,
    events: {} as SdEvent,
    input: {} as SdInput,
  },
  actions: {
    // ── Shared actions (bodies imported, wrapped here) ──
    incrementExchanges:         assign(SHARED_ACTION_IMPLS.incrementExchanges),
    incrementSilenceEvents:     assign(SHARED_ACTION_IMPLS.incrementSilenceEvents),
    incrementProbeCount:        assign(SHARED_ACTION_IMPLS.incrementProbeCount),
    incrementRedirectCount:     assign(SHARED_ACTION_IMPLS.incrementRedirectCount),
    incrementQualityGateRetries: assign(SHARED_ACTION_IMPLS.incrementQualityGateRetries),
    advancePhase:               assign(SHARED_ACTION_IMPLS.advancePhase),
    clearError:                 assign(SHARED_ACTION_IMPLS.clearError),

    // ── Machine-specific actions ──
    logProblemNavPenalty:       assign({ problemNavPenalty: true }),
    setFirstMoveClarify:        assign({ firstMoveFlag: "CLARIFY" as const }),
    setFirstMoveJump:           assign({ firstMoveFlag: "JUMP" as const, problemNavPenalty: true }),
    markSilenceNudgeIssued:     assign({ silenceNudgeIssued: true }),
    markFailureModeChallenged:  assign({ failureModeChallenged: true }),
    markScaleStressTested:      assign({ scaleStressTested: true }),
    resetProbeIndex:            assign({ activeProbeIndex: 0 }),

    issueRedirect: assign(({ context }) => ({
      redirectCount: context.redirectCount + 1,
    })),

    incrementRedirectOnTimeout: assign(({ context }) => ({
      redirectCount: context.redirectCount + 1,
    })),

    applyPlanGenerated: assign(({ event }) => {
      if (event.type !== "PLAN_GENERATED") return {};
      return { interviewObject: event.plan };
    }),

    applyErrorMessage: assign(({ event }) => {
      if (event.type !== "ERROR") return {};
      return { errorMessage: event.message };
    }),

    updateReqCoverage: assign(({ event }) => {
      if (event.type !== "COVERAGE_SCORED") return {};
      return { reqCoverageScore: event.score, weakNfrFlag: event.score < 0.4 };
    }),

    updateEstimation: assign(({ event }) => {
      if (event.type !== "ESTIMATION_SCORED") return {};
      return { estimationScore: event.score, estimationHintIssued: event.hintIssued };
    }),

    recordProbeResponse: assign(({ context, event }) => {
      if (event.type !== "PROBE_EVALUATED") return {};
      const probe = {
        phase: context.phase,
        probeIndex: context.activeProbeIndex,
        response: event.response,
        score: event.score,
      };
      return {
        probeHistory: [...context.probeHistory, probe],
        activeProbeIndex: context.activeProbeIndex + 1,
        probeCount: context.probeCount + 1,
        negativeCollabFlag: context.negativeCollabFlag || event.response === "defensive",
      };
    }),

    updateComponentCoverage: assign(({ event }) => {
      if (event.type !== "COMPONENT_COVERAGE_SCORED") return {};
      return { componentCoverage: event.coverage };
    }),

    updateTradeoffScore: assign(({ context, event }) => {
      if (event.type !== "TRADEOFF_RESPONSE") return {};
      return { tradeoffScore: context.tradeoffScore + event.tradeoffIncrement };
    }),

    applySelfAwarenessFromPhaseComplete: assign(({ event }) => {
      if (event.type !== "PHASE_COMPLETE") return {};
      return { selfAwarenessScore: event.selfAwarenessScore ?? (0 as 0 | 0.5 | 1) };
    }),

    applyDimensionScores: assign(({ event }) => {
      if (event.type !== "SCORE_COMPUTED") return {};
      return { dimensionScores: event.scores, overallScore: event.overall };
    }),

    calcAndSetHireSignal: assign(({ context }) => ({
      hireSignal: calcHireSignal(context.overallScore ?? 0, context.tier) as HireSignal,
    })),

    applyReport: assign(({ event }) => {
      if (event.type !== "REPORT_GENERATED") return {};
      return { report: event.report };
    }),
  },

  guards: {
    ...sharedGuards,
    candidateJumped:          ({ context }) => context.firstMoveFlag === "JUMP",
    reqCoverageGreen:         ({ context }) => context.reqCoverageScore >= 0.7,
    reqCoverageWeak:          ({ context }) => context.reqCoverageScore < 0.4,
    componentCoverageCritical:({ context }) => context.componentCoverage < 0.4,
    probesBudgetRemaining:    ({ context }) => context.activeProbeIndex < 3,
    probeBudgetExhausted:     ({ context }) => context.activeProbeIndex >= 3,
    tradeoffScoreLow:         ({ context }) => context.tradeoffScore < 0.3,
    hasNegativeCollabFlag:    ({ context }) => context.negativeCollabFlag,
    silenceNudgeNotIssued:    ({ context }) => !context.silenceNudgeIssued,
  },
});

// Alias for brevity in state nodes
const a = sd.assign;

// ============================================================
// MACHINE
// ============================================================

export const systemDesignMachine = sd.createMachine({
  id: "system-design",
  initial: "IDLE",

  context: ({ input }: { input: SdInput }) => ({
    sessionId: input.sessionId,
    userId: input.userId,
    role: input.role,
    tier: input.tier,
    level: input.level,
    phase: 0,
    stateName: "IDLE",
    silenceTimerMs: SILENCE_THRESHOLD_MS,
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
    interviewObject: null,
    silenceNudgeIssued: false,
    firstMoveFlag: null,
    reqCoverageScore: 0,
    weakNfrFlag: false,
    estimationScore: 0,
    estimationHintIssued: false,
    componentCoverage: 0,
    probeHistory: [],
    activeProbeIndex: 0,
    tradeoffScore: 0,
    collaborationSignal: null,
    negativeCollabFlag: false,
    failureModeChallenged: false,
    scaleStressTested: false,
    selfAwarenessScore: 0 as const,
    problemNavPenalty: false,
  }),

  states: {
    // ──────────────────────────────────────────────────────────
    // PHASE 0 — Pre-interview generation
    // ──────────────────────────────────────────────────────────
    IDLE: {
      entry: a({ stateName: "IDLE" }),
      on: { START_SESSION: "PARSING_INPUTS" },
    },

    PARSING_INPUTS: {
      entry: a({ stateName: "PARSING_INPUTS", phase: 0 }),
      on: {
        INPUTS_PARSED: "GENERATING_OBJ",
        ERROR: { target: "ERROR_STATE", actions: "applyErrorMessage" },
      },
    },

    GENERATING_OBJ: {
      entry: a({ stateName: "GENERATING_OBJ" }),
      on: {
        PLAN_GENERATED: { target: "QUALITY_GATE", actions: "applyPlanGenerated" },
        ERROR: "ERROR_STATE",
      },
    },

    QUALITY_GATE: {
      entry: a({ stateName: "QUALITY_GATE" }),
      on: {
        QUALITY_GATE_PASS: "INTERVIEW_READY",
        QUALITY_GATE_FAIL: [
          { guard: "qualityGateMaxRetriesReached", target: "INTERVIEW_READY", actions: "incrementQualityGateRetries" },
          { target: "GENERATING_OBJ", actions: "incrementQualityGateRetries" },
        ],
      },
    },

    INTERVIEW_READY: {
      entry: a({ stateName: "INTERVIEW_READY" }),
      on: { CANDIDATE_READY: "DELIVERING" },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 1 — Prompt delivery & silence monitoring
    // ──────────────────────────────────────────────────────────
    DELIVERING: {
      entry: a({ stateName: "DELIVERING", phase: 1 }),
      on: {
        CANDIDATE_RESPONSE: "FIRST_MOVE_DETECT",
        SILENCE_DETECTED: "SILENCE_WATCH",
      },
    },

    SILENCE_WATCH: {
      entry: [a({ stateName: "SILENCE_WATCH" }), "incrementSilenceEvents"],
      after: { [SILENCE_THRESHOLD_MS]: "SILENCE_NUDGE_ISSUED" },
      on: { CANDIDATE_RESPONSE: "FIRST_MOVE_DETECT" },
    },

    SILENCE_NUDGE_ISSUED: {
      entry: ["markSilenceNudgeIssued", a({ stateName: "SILENCE_NUDGE_ISSUED" })],
      on: {
        CANDIDATE_RESPONSE: "FIRST_MOVE_DETECT",
        SILENCE_DETECTED: "SILENCE_WATCH",
      },
    },

    FIRST_MOVE_DETECT: {
      entry: a({ stateName: "FIRST_MOVE_DETECT" }),
      on: {
        FIRST_MOVE_CLARIFY: { target: "CLARIFY_STARTED", actions: "setFirstMoveClarify" },
        FIRST_MOVE_JUMP:    { target: "SOLUTION_JUMPED", actions: "setFirstMoveJump" },
      },
    },

    CLARIFY_STARTED: {
      entry: a({ stateName: "CLARIFY_STARTED" }),
      on: { PHASE_COMPLETE: "CLARIFYING" },
    },

    SOLUTION_JUMPED: {
      entry: [a({ stateName: "SOLUTION_JUMPED" }), "logProblemNavPenalty", "issueRedirect"],
      on: { PHASE_COMPLETE: "CLARIFYING" },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 2 — Requirement clarification
    // ──────────────────────────────────────────────────────────
    CLARIFYING: {
      entry: a({ stateName: "CLARIFYING", phase: 2 }),
      after: {
        [PHASE_BUDGETS_MS.system_design[2]]: {
          target: "REQUIREMENT_CONFIRM",
          actions: "incrementRedirectOnTimeout",
        },
      },
      on: {
        CANDIDATE_RESPONSE: "NFR_NUDGE_CHECK",
        TIMEOUT: "REQUIREMENT_CONFIRM",
      },
    },

    NFR_NUDGE_CHECK: {
      entry: a({ stateName: "NFR_NUDGE_CHECK" }),
      on: { PHASE_COMPLETE: "SCORING_COVERAGE" },
    },

    SCORING_COVERAGE: {
      entry: a({ stateName: "SCORING_COVERAGE" }),
      on: {
        COVERAGE_SCORED: { target: "REQUIREMENT_CONFIRM", actions: "updateReqCoverage" },
      },
    },

    REQUIREMENT_CONFIRM: {
      entry: a({ stateName: "REQUIREMENT_CONFIRM" }),
      on: { CANDIDATE_READY: "ESTIMATING" },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 3 — Capacity estimation
    // ──────────────────────────────────────────────────────────
    ESTIMATING: {
      entry: a({ stateName: "ESTIMATING", phase: 3 }),
      after: { [PHASE_BUDGETS_MS.system_design[3]]: "SCORING_ESTIMATION" },
      on: {
        CANDIDATE_RESPONSE: "MATH_VALIDATION",
        TIMEOUT: "SCORING_ESTIMATION",
      },
    },

    MATH_VALIDATION: {
      entry: a({ stateName: "MATH_VALIDATION" }),
      on: { PHASE_COMPLETE: "SCAFFOLDING_CHECK" },
    },

    SCAFFOLDING_CHECK: {
      entry: a({ stateName: "SCAFFOLDING_CHECK" }),
      on: {
        PHASE_COMPLETE: "SCORING_ESTIMATION",
        CANDIDATE_RESPONSE: "SCORING_ESTIMATION",
      },
    },

    SCORING_ESTIMATION: {
      entry: a({ stateName: "SCORING_ESTIMATION" }),
      on: {
        ESTIMATION_SCORED: { target: "HLD_LISTENING", actions: "updateEstimation" },
      },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 4 — High-level design
    // ──────────────────────────────────────────────────────────
    HLD_LISTENING: {
      entry: [a({ stateName: "HLD_LISTENING", phase: 4 }), "resetProbeIndex"],
      after: { [PHASE_BUDGETS_MS.system_design[4]]: "SCORING_COMPONENT_COVERAGE" },
      on: {
        CANDIDATE_RESPONSE: "GAP_DETECTION",
        TIMEOUT: "SCORING_COMPONENT_COVERAGE",
      },
    },

    GAP_DETECTION: {
      entry: a({ stateName: "GAP_DETECTION" }),
      on: {
        PHASE_COMPLETE: [
          { guard: "probesBudgetRemaining", target: "PROBE_ISSUE" },
          { target: "SCORING_COMPONENT_COVERAGE" },
        ],
        TIMEOUT: "SCORING_COMPONENT_COVERAGE",
      },
    },

    PROBE_ISSUE: {
      entry: ["incrementProbeCount", a({ stateName: "PROBE_ISSUE" })],
      on: { CANDIDATE_RESPONSE: "PROBE_RESPONSE_EVAL" },
    },

    PROBE_RESPONSE_EVAL: {
      entry: a({ stateName: "PROBE_RESPONSE_EVAL" }),
      on: {
        PROBE_EVALUATED: [
          { guard: "probesBudgetRemaining", target: "PROBE_ISSUE",                actions: "recordProbeResponse" },
          {                                 target: "SCORING_COMPONENT_COVERAGE", actions: "recordProbeResponse" },
        ],
      },
    },

    SCORING_COMPONENT_COVERAGE: {
      entry: a({ stateName: "SCORING_COMPONENT_COVERAGE" }),
      on: {
        COMPONENT_COVERAGE_SCORED: [
          { guard: "componentCoverageCritical", target: "DATA_LAYER_REDIRECT", actions: "updateComponentCoverage" },
          {                                     target: "WEAK_POINT_SELECT",   actions: "updateComponentCoverage" },
        ],
      },
    },

    DATA_LAYER_REDIRECT: {
      entry: ["issueRedirect", a({ stateName: "DATA_LAYER_REDIRECT" })],
      on: { CANDIDATE_RESPONSE: "WEAK_POINT_SELECT" },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 5 — Deep dive & trade-off challenge
    // ──────────────────────────────────────────────────────────
    WEAK_POINT_SELECT: {
      entry: a({ stateName: "WEAK_POINT_SELECT", phase: 5 }),
      on: { PHASE_COMPLETE: "TRADEOFF_CHALLENGE" },
    },

    TRADEOFF_CHALLENGE: {
      entry: a({ stateName: "TRADEOFF_CHALLENGE" }),
      on: {
        TRADEOFF_RESPONSE: { target: "FAILURE_MODE_PROBE", actions: "updateTradeoffScore" },
      },
    },

    FAILURE_MODE_PROBE: {
      entry: ["markFailureModeChallenged", a({ stateName: "FAILURE_MODE_PROBE" })],
      on: {
        TRADEOFF_RESPONSE: { target: "SCALE_STRESS_TEST", actions: "updateTradeoffScore" },
      },
    },

    SCALE_STRESS_TEST: {
      entry: ["markScaleStressTested", a({ stateName: "SCALE_STRESS_TEST" })],
      on: { CANDIDATE_RESPONSE: "ADAPTATION_SCORING" },
    },

    ADAPTATION_SCORING: {
      entry: a({ stateName: "ADAPTATION_SCORING" }),
      on: { PHASE_COMPLETE: "SELF_CRITIQUE_PROMPT" },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 6 — Self-critique & wrap-up
    // ──────────────────────────────────────────────────────────
    SELF_CRITIQUE_PROMPT: {
      entry: a({ stateName: "SELF_CRITIQUE_PROMPT", phase: 6 }),
      on: { CANDIDATE_RESPONSE: "SELF_AWARENESS_SCORE" },
    },

    SELF_AWARENESS_SCORE: {
      entry: a({ stateName: "SELF_AWARENESS_SCORE" }),
      on: {
        PHASE_COMPLETE: { target: "CANDIDATE_QA", actions: "applySelfAwarenessFromPhaseComplete" },
      },
    },

    CANDIDATE_QA: {
      entry: a({ stateName: "CANDIDATE_QA" }),
      on: {
        PHASE_COMPLETE: "SESSION_CLOSING",
        CANDIDATE_RESPONSE: "CANDIDATE_QA",
      },
    },

    SESSION_CLOSING: {
      entry: a({ stateName: "SESSION_CLOSING" }),
      on: { PHASE_COMPLETE: "DIMENSION_SCORING" },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 7 — Scoring & feedback generation
    // ──────────────────────────────────────────────────────────
    DIMENSION_SCORING: {
      entry: a({ stateName: "DIMENSION_SCORING", phase: 7 }),
      on: {
        SCORE_COMPUTED: { target: "EVIDENCE_MAPPING", actions: "applyDimensionScores" },
      },
    },

    EVIDENCE_MAPPING: {
      entry: a({ stateName: "EVIDENCE_MAPPING" }),
      on: { PHASE_COMPLETE: "HIRE_SIGNAL_CALC" },
    },

    HIRE_SIGNAL_CALC: {
      entry: a({ stateName: "HIRE_SIGNAL_CALC" }),
      on: {
        PHASE_COMPLETE: { target: "REPORT_GENERATED", actions: "calcAndSetHireSignal" },
      },
    },

    REPORT_GENERATED: {
      entry: a({ stateName: "REPORT_GENERATED" }),
      on: {
        REPORT_GENERATED: { target: "TERMINAL_COMPLETED", actions: "applyReport" },
      },
    },

    // ── TERMINAL STATES ──
    TERMINAL_COMPLETED: {
      type: "final" as const,
      entry: a({ stateName: "TERMINAL_COMPLETED" }),
    },

    ERROR_STATE: {
      type: "final" as const,
      entry: a({ stateName: "ERROR_STATE" }),
    },
  },
});

export type SystemDesignMachine = typeof systemDesignMachine;
export type SystemDesignActor = ActorRefFrom<SystemDesignMachine>;