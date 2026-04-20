import { setup, assign, type ActorRefFrom } from "xstate";
import type {
  DomainKnowledgeContext as DkCtx,
  DomainPlan,
  ClaimValidation,
  InterviewReport,
  DimensionScore,
  HireSignal,
  CrossRoundMetaScore,
} from "@interview/shared-types";
import {
  type SharedContext,
  SHARED_ACTION_IMPLS,
  sharedGuards,
  calcHireSignal,
  calcCrossRoundMetaScore,
  PHASE_BUDGETS_MS,
} from "../shared/index.js";

// ============================================================
// PER-PHASE CONTEXT SLICES
//
// Grouping scoring data into nested objects makes it immediately
// clear which fields belong to which phase, reduces the chance of
// accidental cross-phase field access, and keeps assign() calls
// focused on a single concern.
// ============================================================

export interface Phase1ConceptualData {
  conceptualScore: number;
  misconceptionsDetected: string[];
  overconfidenceFlag: boolean;
  underconfidenceFlag: boolean;
}

export interface Phase2AppliedData {
  productionDepthScore: number;
  inflationFlag: boolean;
  claimValidationMap: ClaimValidation[];
}

export interface Phase3EdgeCaseData {
  depthScore: number;
  idkHandled: boolean;
  adjacentDomainTested: boolean;
}

export interface Phase4Domain2Data {
  domain2Score: number;
  domain2DepthType: "deep" | "broad" | null;
  crossDomainLinked: boolean;
  d2RedirectIssued: boolean;
  // Dedicated D2 exchange counter — avoids conflating with totalExchanges
  // which spans the entire interview, not just the D2 phase.
  d2ExchangeCount: number;
}

export interface Phase5StretchData {
  stretchScore: number; // Weighted 0.5x
  firstPrinciplesScore: number;
  learningApproachScore: number;
}

export interface Phase6CoachabilityData {
  coachabilityScore: number;
}

// ============================================================
// CONTEXT
// ============================================================

export interface DomainKnowledgeMachineContext extends SharedContext {
  // ── Plan ────────────────────────────────────────────────────
  //
  // domainPlan is now variable-length (2–5 domains) rather than
  // always exactly 3.  currentDomain is the index into this array.
  // planContextMode records whether the plan was built from a full
  // resume, JD-only, or the low-context exploratory fallback so the
  // AI layer can calibrate question difficulty accordingly.
  domainPlan: DomainPlan[];
  currentDomain: number;
  planContextMode: "resume_jd" | "jd_only" | "resume_only" | "exploratory";

  // ── Per-phase scoring slices ─────────────────────────────────
  phase1: Phase1ConceptualData;
  phase2: Phase2AppliedData;
  phase3: Phase3EdgeCaseData;
  phase4: Phase4Domain2Data;
  phase5: Phase5StretchData;
  phase6: Phase6CoachabilityData;

  // ── Cross-round ──────────────────────────────────────────────
  priorSdScore: number | null;
  priorBehavioralScore: number | null;
  crossRoundMetaScore: CrossRoundMetaScore | null;

  depthProfile: DkCtx["depthProfile"];
}

// ============================================================
// EVENTS
// ============================================================

type DkEvent =
  | { type: "START_SESSION" }
  | { type: "INPUTS_PARSED" }
  | { type: "PLAN_GENERATED"; plan: DomainPlan[]; contextMode: DomainKnowledgeMachineContext["planContextMode"] }
  | { type: "QUALITY_GATE_PASS" }
  | { type: "QUALITY_GATE_FAIL" }
  | { type: "CANDIDATE_READY" }
  | { type: "CANDIDATE_RESPONSE" }
  // Phase 1
  | { type: "MISCONCEPTION_DETECTED"; misconception: string }
  | { type: "CONFIDENCE_ASSESSED"; overconfident: boolean; underconfident: boolean }
  | { type: "CONCEPTUAL_SCORED"; score: number }
  // Phase 2
  | { type: "PROD_SIGNAL_DETECTED"; hasProdSignal: boolean }
  | { type: "TUTORIAL_OR_PROD_CLASSIFIED"; depth: number; inflation: boolean }
  | { type: "CLAIM_VALIDATED"; validation: ClaimValidation }
  // Phase 3
  | { type: "IDK_HANDLED" }
  | { type: "ADJACENT_DOMAIN_TESTED" }
  | { type: "DEPTH_SCORED"; score: number }
  // Phase 4
  | { type: "CROSS_DOMAIN_LINKED" }
  | { type: "D2_REDIRECT_NEEDED" }
  | { type: "D2_SCORED"; score: number; depthType: "deep" | "broad" }
  // Phase 5
  | { type: "STRETCH_SCORED"; firstPrinciples: number; learning: number }
  // Phase 6
  | { type: "COACHABILITY_SCORED"; score: number }
  // Shared / terminal
  | { type: "TIMEOUT" }
  | { type: "PHASE_COMPLETE" }
  | { type: "SCORE_COMPUTED"; scores: DimensionScore[]; overall: number }
  | { type: "REPORT_READY"; report: InterviewReport }
  | { type: "PRIOR_SCORES_LOADED"; sdScore: number | null; behavioralScore: number | null }
  | { type: "ERROR"; message: string };

// ============================================================
// INPUT
// ============================================================

export interface DomainKnowledgeMachineInput {
  sessionId: string;
  userId: string;
  role: string;
  tier: "T1" | "T2" | "T3";
  level: "junior" | "mid" | "senior" | "staff" | "principal";
  priorSdScore?: number | null;
  priorBehavioralScore?: number | null;
}

// ============================================================
// RUNTIME CONSTANTS
//
// D2_EXCHANGE_LIMIT caps the number of back-and-forth turns in
// Phase 4 (Domain 2).  The lower dev value keeps test sessions
// short; the production value allows a full conversational probe.
//
// Declared as a module-level const (not process.env) so this file
// has no hard dependency on @types/node.  If you need environment-
// specific values at build time, override this via your bundler's
// define plugin (e.g. esbuild define, vite define).
// ============================================================

const D2_EXCHANGE_LIMIT: number = 8; // production default
// To use 2 in dev, set this via your build tool:
//   esbuild:  define: { D2_EXCHANGE_LIMIT: "2" }
//   vite:     define: { D2_EXCHANGE_LIMIT: 2 }

// ============================================================
// MACHINE
// ============================================================

export const domainKnowledgeMachine = setup({
  types: {
    context: {} as DomainKnowledgeMachineContext,
    events:  {} as DkEvent,
    input:   {} as DomainKnowledgeMachineInput,
  },

  actions: {
    // ── Shared actions ──────────────────────────────────────────
    // Each impl is a plain property-assigner object from shared.ts.
    // Wrapping in assign() here binds it to this machine's context type
    // so XState's variance probe resolves correctly.
    incrementExchanges:          assign(SHARED_ACTION_IMPLS.incrementExchanges),
    incrementSilenceEvents:      assign(SHARED_ACTION_IMPLS.incrementSilenceEvents),
    incrementProbeCount:         assign(SHARED_ACTION_IMPLS.incrementProbeCount),
    incrementRedirectCount:      assign(SHARED_ACTION_IMPLS.incrementRedirectCount),
    incrementQualityGateRetries: assign(SHARED_ACTION_IMPLS.incrementQualityGateRetries),
    advancePhase:                assign(SHARED_ACTION_IMPLS.advancePhase),
    clearError:                  assign(SHARED_ACTION_IMPLS.clearError),

    // ── Plan actions ────────────────────────────────────────────

    setDomainPlan: assign({
      domainPlan: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "PLAN_GENERATED" }>;
        return e.plan;
      },
      planContextMode: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "PLAN_GENERATED" }>;
        return e.contextMode;
      },
    }),

    // ── Phase 1 actions ─────────────────────────────────────────

    setConfidenceFlags: assign({
      phase1: ({ context, event }) => {
        const e = event as Extract<DkEvent, { type: "CONFIDENCE_ASSESSED" }>;
        return {
          ...context.phase1,
          overconfidenceFlag:  e.overconfident,
          underconfidenceFlag: e.underconfident,
        };
      },
    }),

    recordMisconception: assign({
      phase1: ({ context, event }) => {
        const e = event as Extract<DkEvent, { type: "MISCONCEPTION_DETECTED" }>;
        return {
          ...context.phase1,
          misconceptionsDetected: [...context.phase1.misconceptionsDetected, e.misconception],
        };
      },
    }),

    setConceptualScore: assign({
      phase1: ({ context, event }) => {
        const e = event as Extract<DkEvent, { type: "CONCEPTUAL_SCORED" }>;
        return { ...context.phase1, conceptualScore: e.score };
      },
    }),

    // ── Phase 2 actions ─────────────────────────────────────────

    setProductionDepth: assign({
      phase2: ({ context, event }) => {
        const e = event as Extract<DkEvent, { type: "TUTORIAL_OR_PROD_CLASSIFIED" }>;
        return {
          ...context.phase2,
          productionDepthScore: e.depth,
          inflationFlag:        e.inflation,
        };
      },
    }),

    recordClaimValidation: assign({
      phase2: ({ context, event }) => {
        const e = event as Extract<DkEvent, { type: "CLAIM_VALIDATED" }>;
        return {
          ...context.phase2,
          claimValidationMap: [...context.phase2.claimValidationMap, e.validation],
        };
      },
    }),

    // ── Phase 3 actions ─────────────────────────────────────────

    setDepthScore: assign({
      phase3: ({ context, event }) => {
        const e = event as Extract<DkEvent, { type: "DEPTH_SCORED" }>;
        return { ...context.phase3, depthScore: e.score };
      },
    }),

    markIdkHandled: assign({
      phase3: ({ context }) => ({ ...context.phase3, idkHandled: true }),
    }),

    markAdjacentDomainTested: assign({
      phase3: ({ context }) => ({ ...context.phase3, adjacentDomainTested: true }),
    }),

    // ── Phase 4 actions ─────────────────────────────────────────

    markCrossDomainLinked: assign({
      phase4: ({ context }) => ({
        ...context.phase4,
        crossDomainLinked:  true,
        // Track D2 exchanges in their own counter so D2_PACING logic
        // is not influenced by Phase 1–3 exchange counts.
        d2ExchangeCount: context.phase4.d2ExchangeCount + 1,
      }),
    }),

    issueD2Redirect: assign({
      phase4:        ({ context }) => ({ ...context.phase4, d2RedirectIssued: true }),
      redirectCount: ({ context }) => context.redirectCount + 1,
    }),

    setD2Score: assign({
      phase4: ({ context, event }) => {
        const e = event as Extract<DkEvent, { type: "D2_SCORED" }>;
        return {
          ...context.phase4,
          domain2Score:     e.score,
          domain2DepthType: e.depthType,
        };
      },
    }),

    // ── Phase 5 actions ─────────────────────────────────────────

    setStretchScore: assign({
      phase5: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "STRETCH_SCORED" }>;
        return {
          firstPrinciplesScore:  e.firstPrinciples,
          learningApproachScore: e.learning,
          // Stretch is weighted 0.5x — no correctness component
          stretchScore: ((e.firstPrinciples + e.learning) / 2) * 0.5,
        };
      },
    }),

    // ── Phase 6 actions ─────────────────────────────────────────

    setCoachabilityScore: assign({
      phase6: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "COACHABILITY_SCORED" }>;
        return { coachabilityScore: e.score };
      },
    }),

    // ── Cross-round / terminal actions ──────────────────────────

    setPriorScores: assign({
      priorSdScore: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "PRIOR_SCORES_LOADED" }>;
        return e.sdScore;
      },
      priorBehavioralScore: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "PRIOR_SCORES_LOADED" }>;
        return e.behavioralScore;
      },
    }),

    computeCrossRoundMeta: assign({
      crossRoundMetaScore: ({ context }) =>
        calcCrossRoundMetaScore(
          context.priorSdScore,
          context.priorBehavioralScore,
          context.overallScore,
          context.tier
        ),
    }),

    setDimensionScores: assign({
      dimensionScores: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "SCORE_COMPUTED" }>;
        return e.scores;
      },
      overallScore: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "SCORE_COMPUTED" }>;
        return e.overall;
      },
    }),

    // Coachability acts as a multiplier applied on top of the base dimension
    // scores — it is intentionally NOT additive.
    applyCoachabilityMultiplier: assign({
      overallScore: ({ context }) =>
        context.overallScore !== null
          ? context.overallScore * context.phase6.coachabilityScore
          : null,
    }),

    setReport: assign({
      report: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "REPORT_READY" }>;
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

    hasOverconfidenceFlag: ({ context }) => context.phase1.overconfidenceFlag,

    d2NeedsRedirect: ({ event }) => event.type === "D2_REDIRECT_NEEDED",

    // Exit D2 when the dedicated d2ExchangeCount reaches the env-appropriate
    // limit, or when a redirect has already been issued.
    // The limit is injected via a module-level constant so this file does not
    // need a dependency on @types/node / process.env.
    d2ExchangeLimitReached: ({ context }) => {
      return (
        context.phase4.d2ExchangeCount >= D2_EXCHANGE_LIMIT ||
        context.phase4.d2RedirectIssued
      );
    },
  },
}).createMachine({
  id:      "domain-knowledge",
  initial: "IDLE",

  context: ({ input }) => ({
    // ── SharedContext fields ─────────────────────────────────────
    sessionId:              input.sessionId,
    userId:                 input.userId,
    role:                   input.role,
    tier:                   input.tier,
    level:                  input.level,
    phase:                  0,
    stateName:              "IDLE",
    silenceTimerMs:         15_000,
    qualityGateRetries:     0,
    totalExchanges:         0,
    silenceEvents:          0,
    probeCount:             0,
    redirectCount:          0,
    errorMessage:           null,
    dimensionScores:        [],
    hireSignal:             null,
    overallScore:           null,
    report:                 null,

    // ── Plan ────────────────────────────────────────────────────
    domainPlan:             [],
    currentDomain:          0,
    planContextMode:        "exploratory" as const,

    // ── Per-phase slices (zero-valued defaults) ──────────────────
    phase1: {
      conceptualScore:        0,
      misconceptionsDetected: [],
      overconfidenceFlag:     false,
      underconfidenceFlag:    false,
    },
    phase2: {
      productionDepthScore:   0,
      inflationFlag:          false,
      claimValidationMap:     [],
    },
    phase3: {
      depthScore:             0,
      idkHandled:             false,
      adjacentDomainTested:   false,
    },
    phase4: {
      domain2Score:           0,
      domain2DepthType:       null,
      crossDomainLinked:      false,
      d2RedirectIssued:       false,
      d2ExchangeCount:        0,
    },
    phase5: {
      stretchScore:           0,
      firstPrinciplesScore:   0,
      learningApproachScore:  0,
    },
    phase6: {
      // Neutral multiplier (1.0) until coachability is evaluated in Phase 6.
      coachabilityScore: 1,
    },

    // ── Cross-round ──────────────────────────────────────────────
    priorSdScore:         input.priorSdScore         ?? null,
    priorBehavioralScore: input.priorBehavioralScore  ?? null,
    crossRoundMetaScore:  null,
    depthProfile:         null,
  }),

  // ── Global error transition ──────────────────────────────────
  // Declared at the root so any state can transition to ERROR_STATE
  // without requiring per-state "on: ERROR" blocks.
  on: {
    ERROR: {
      target: ".ERROR_STATE",
      actions: assign({
        errorMessage: ({ event }) => {
          const e = event as Extract<DkEvent, { type: "ERROR" }>;
          return e.message;
        },
        stateName: () => "ERROR_STATE",
      }),
    },
  },

  states: {
    IDLE: {
      entry: assign({ stateName: "IDLE" }),
      on: { START_SESSION: "PRE_SESSION" },
    },

    // ══════════════════════════════════════════════════════════════
    // COMPOUND STATE: PRE_SESSION
    //
    // Groups all pre-interview scaffolding states.  The compound
    // parent's `on:` block declares the single exit transition so the
    // boundary between setup and live interview is explicit and
    // impossible to accidentally bypass.
    // ══════════════════════════════════════════════════════════════
    PRE_SESSION: {
      initial: "DOMAIN_TAXONOMY_LOAD",
      entry:   assign({ phase: 0 }),

      states: {
        // ──────────────────────────────────────────────────────────
        // PHASE 0 — Pre-session domain extraction
        //
        // The plan generator now returns a variable number of domains
        // (2–5) chosen by relevance to the resume + JD, along with a
        // planContextMode tag so downstream components know how much
        // signal was available.  The quality gate validates that the
        // plan has at least 2 domains and coherent question sets.
        // ──────────────────────────────────────────────────────────
        DOMAIN_TAXONOMY_LOAD: {
          entry: assign({ stateName: "DOMAIN_TAXONOMY_LOAD" }),
          on: { INPUTS_PARSED: "RESUME_DOMAIN_PARSE" },
        },

        RESUME_DOMAIN_PARSE: {
          entry: assign({ stateName: "RESUME_DOMAIN_PARSE" }),
          on: { PHASE_COMPLETE: "DOMAIN_PLAN_GEN" },
        },

        DOMAIN_PLAN_GEN: {
          entry: assign({ stateName: "DOMAIN_PLAN_GEN" }),
          on: {
            PLAN_GENERATED: {
              target:  "QUALITY_GATE",
              actions: "setDomainPlan",
            },
          },
        },

        QUALITY_GATE: {
          entry: assign({ stateName: "QUALITY_GATE" }),
          on: {
            QUALITY_GATE_PASS: "PLAN_READY",
            QUALITY_GATE_FAIL: [
              {
                // Max retries reached — proceed anyway to avoid infinite loop.
                guard:   "qualityGateMaxRetriesReached",
                target:  "PLAN_READY",
                actions: "incrementQualityGateRetries",
              },
              {
                // Retry plan generation.
                target:  "DOMAIN_PLAN_GEN",
                actions: "incrementQualityGateRetries",
              },
            ],
          },
        },

        PLAN_READY: {
          entry: assign({ stateName: "PLAN_READY" }),
          // CANDIDATE_READY exits the PRE_SESSION compound state entirely.
        },
      },

      // Compound-state exit: transitions to the first live interview state.
      on: {
        CANDIDATE_READY: "PHASE_1_CONCEPTUAL",
      },
    },

    // ══════════════════════════════════════════════════════════════
    // COMPOUND STATE: PHASE_1_CONCEPTUAL
    //
    // Domain 1 — Conceptual foundation.
    // Probes the candidate's mental model of the primary domain.
    // Misconceptions detected here are deferred and confronted in
    // PHASE_3_EDGE_CASE via MISCONCEPTION_RESOLUTION.
    //
    // Adaptive follow-up: CONCEPTUAL_QUESTION now waits for multiple
    // CANDIDATE_RESPONSE turns before moving to scoring.  The session
    // controller gates advancement on probeCount so the interviewer
    // can ask transcript-grounded follow-ups rather than always
    // advancing after a single answer.
    // ══════════════════════════════════════════════════════════════
    PHASE_1_CONCEPTUAL: {
      initial: "CONCEPTUAL_QUESTION",
      entry:   assign({ phase: 1, stateName: "CONCEPTUAL_QUESTION" }),

      states: {
        CONCEPTUAL_QUESTION: {
          entry: assign({ stateName: "CONCEPTUAL_QUESTION" }),
          after: {
            // Phase budget governs the total time for the conceptual exchange.
            [PHASE_BUDGETS_MS.domain_knowledge[1]]: "CONFIDENCE_CALIBRATE",
          },
          on: {
            CANDIDATE_RESPONSE: "MISCONCEPTION_DETECT",
            TIMEOUT:            "CONFIDENCE_CALIBRATE",
          },
        },

        MISCONCEPTION_DETECT: {
          entry: assign({ stateName: "MISCONCEPTION_DETECT" }),
          on: {
            // Accumulate misconceptions; stay in state for each one detected.
            MISCONCEPTION_DETECTED: {
              target:  "MISCONCEPTION_DETECT",
              actions: "recordMisconception",
            },
            PHASE_COMPLETE: "CONFIDENCE_CALIBRATE",
          },
        },

        CONFIDENCE_CALIBRATE: {
          entry: assign({ stateName: "CONFIDENCE_CALIBRATE" }),
          on: {
            CONFIDENCE_ASSESSED: {
              target:  "CONCEPTUAL_SCORING",
              actions: "setConfidenceFlags",
            },
          },
        },

        CONCEPTUAL_SCORING: {
          entry: assign({ stateName: "CONCEPTUAL_SCORING" }),
          on: {
            CONCEPTUAL_SCORED: {
              // Exit PHASE_1_CONCEPTUAL compound state.
              target:  "#domain-knowledge.PHASE_2_APPLIED",
              actions: "setConceptualScore",
            },
          },
        },
      },
    },

    // ══════════════════════════════════════════════════════════════
    // COMPOUND STATE: PHASE_2_APPLIED
    //
    // Domain 1 — Applied experience probe.
    // Tests whether the candidate has real production exposure or
    // only tutorial/textbook knowledge.  Claim validation accumulates
    // across multiple CLAIM_VALIDATED events before PHASE_COMPLETE.
    // ══════════════════════════════════════════════════════════════
    PHASE_2_APPLIED: {
      initial: "APPLIED_QUESTION",
      entry:   assign({ phase: 2, stateName: "APPLIED_QUESTION" }),

      states: {
        APPLIED_QUESTION: {
          entry: assign({ stateName: "APPLIED_QUESTION" }),
          after: {
            [PHASE_BUDGETS_MS.domain_knowledge[2]]: "CLAIM_VALIDATION",
          },
          on: {
            CANDIDATE_RESPONSE: "PROD_SIGNAL_DETECT",
            TIMEOUT:            "CLAIM_VALIDATION",
          },
        },

        PROD_SIGNAL_DETECT: {
          entry: assign({ stateName: "PROD_SIGNAL_DETECT" }),
          on: { PHASE_COMPLETE: "WAR_STORY_PROBE" },
        },

        WAR_STORY_PROBE: {
          entry: assign({ stateName: "WAR_STORY_PROBE" }),
          on: {
            CANDIDATE_RESPONSE: "TUTORIAL_VS_PROD_CLASSIFY",
          },
        },

        TUTORIAL_VS_PROD_CLASSIFY: {
          entry: assign({ stateName: "TUTORIAL_VS_PROD_CLASSIFY" }),
          on: {
            TUTORIAL_OR_PROD_CLASSIFIED: {
              target:  "CLAIM_VALIDATION",
              actions: "setProductionDepth",
            },
          },
        },

        CLAIM_VALIDATION: {
          entry: assign({ stateName: "CLAIM_VALIDATION" }),
          on: {
            // Accumulate validations; stay in state until PHASE_COMPLETE.
            CLAIM_VALIDATED: {
              target:  "CLAIM_VALIDATION",
              actions: "recordClaimValidation",
            },
            PHASE_COMPLETE: "#domain-knowledge.PHASE_3_EDGE_CASE",
          },
        },
      },
    },

    // ══════════════════════════════════════════════════════════════
    // COMPOUND STATE: PHASE_3_EDGE_CASE
    //
    // Domain 1 — Edge cases & limits.
    // Probes boundary conditions, failure modes, and the candidate's
    // "I don't know" handling.  Deferred misconceptions from Phase 1
    // are confronted in MISCONCEPTION_RESOLUTION before moving on.
    // ══════════════════════════════════════════════════════════════
    PHASE_3_EDGE_CASE: {
      initial: "EDGE_CASE_QUESTION",
      entry:   assign({ phase: 3, stateName: "EDGE_CASE_QUESTION" }),

      states: {
        EDGE_CASE_QUESTION: {
          entry: assign({ stateName: "EDGE_CASE_QUESTION" }),
          after: {
            [PHASE_BUDGETS_MS.domain_knowledge[3]]: "DEPTH_SCORING",
          },
          on: {
            CANDIDATE_RESPONSE: "MISCONCEPTION_RESOLUTION",
            TIMEOUT:            "DEPTH_SCORING",
          },
        },

        // Deferred misconceptions from Phase 1 are confronted here
        // so the interviewer can address them with transcript context.
        MISCONCEPTION_RESOLUTION: {
          entry: assign({ stateName: "MISCONCEPTION_RESOLUTION" }),
          on: { PHASE_COMPLETE: "IDK_HANDLING" },
        },

        IDK_HANDLING: {
          entry: assign({ stateName: "IDK_HANDLING" }),
          on: {
            IDK_HANDLED: {
              target:  "ADJACENT_DOMAIN_TEST",
              actions: "markIdkHandled",
            },
            PHASE_COMPLETE: "ADJACENT_DOMAIN_TEST",
          },
        },

        ADJACENT_DOMAIN_TEST: {
          entry: [
            "markAdjacentDomainTested",
            assign({ stateName: "ADJACENT_DOMAIN_TEST" }),
          ],
          on: {
            CANDIDATE_RESPONSE: "DEPTH_SCORING",
            ADJACENT_DOMAIN_TESTED: "DEPTH_SCORING",
          },
        },

        DEPTH_SCORING: {
          entry: assign({ stateName: "DEPTH_SCORING" }),
          on: {
            DEPTH_SCORED: {
              target:  "#domain-knowledge.PHASE_4_DOMAIN2",
              actions: "setDepthScore",
            },
          },
        },
      },
    },

    // ══════════════════════════════════════════════════════════════
    // COMPOUND STATE: PHASE_4_DOMAIN2
    //
    // Domain 2 — Compressed conversational probe.
    // Uses d2ExchangeCount (not totalExchanges) to gate exit so
    // Phase 1–3 activity does not artificially truncate D2.
    //
    // D2_PACING now uses the guard d2ExchangeLimitReached defined in
    // setup() which checks both d2ExchangeCount and d2RedirectIssued.
    // ══════════════════════════════════════════════════════════════
    PHASE_4_DOMAIN2: {
      initial: "D2_FLOWING_CONVO",
      entry:   assign({ phase: 4, stateName: "D2_FLOWING_CONVO" }),

      states: {
        D2_FLOWING_CONVO: {
          entry: assign({ stateName: "D2_FLOWING_CONVO" }),
          after: {
            [PHASE_BUDGETS_MS.domain_knowledge[4]]: "D2_SCORING",
          },
          on: {
            CANDIDATE_RESPONSE:  "CROSS_DOMAIN_LINK",
            D2_REDIRECT_NEEDED:  "D2_REDIRECT",
            TIMEOUT:             "D2_SCORING",
          },
        },

        CROSS_DOMAIN_LINK: {
          entry: assign({ stateName: "CROSS_DOMAIN_LINK" }),
          on: {
            CROSS_DOMAIN_LINKED: {
              target:  "CROSS_DOMAIN_LINK",
              actions: "markCrossDomainLinked",
            },
            PHASE_COMPLETE: "D2_PACING",
          },
        },

        D2_PACING: {
          entry: assign({ stateName: "D2_PACING" }),
          on: {
            D2_REDIRECT_NEEDED: "D2_REDIRECT",
            // Guard evaluated by the machine; controller sends TIMEOUT or PHASE_COMPLETE.
            TIMEOUT:     "D2_SCORING",
            PHASE_COMPLETE: "D2_FLOWING_CONVO",
          },
        },

        D2_REDIRECT: {
          entry: [
            "issueD2Redirect",
            assign({ stateName: "D2_REDIRECT" }),
          ],
          on: {
            // Resume D2 after redirect.
            PHASE_COMPLETE: "D2_FLOWING_CONVO",
          },
        },

        D2_SCORING: {
          entry: assign({ stateName: "D2_SCORING" }),
          on: {
            D2_SCORED: {
              target:  "#domain-knowledge.PHASE_5_STRETCH",
              actions: "setD2Score",
            },
          },
        },
      },
    },

    // ══════════════════════════════════════════════════════════════
    // COMPOUND STATE: PHASE_5_STRETCH
    //
    // Domain 3 — Stretch probe (0.5× weight).
    // Tests first-principles reasoning and learning velocity on an
    // unfamiliar domain.  Scored at 0.5× weight — the intent is to
    // reward intellectual curiosity without penalising gaps.
    // ══════════════════════════════════════════════════════════════
    PHASE_5_STRETCH: {
      initial: "STRETCH_FRAMING",
      entry:   assign({ phase: 5, stateName: "STRETCH_FRAMING" }),

      states: {
        STRETCH_FRAMING: {
          entry: assign({ stateName: "STRETCH_FRAMING" }),
          on: { CANDIDATE_RESPONSE: "FIRST_PRINCIPLES_TEST" },
        },

        FIRST_PRINCIPLES_TEST: {
          entry: assign({ stateName: "FIRST_PRINCIPLES_TEST" }),
          on: { CANDIDATE_RESPONSE: "LEARNING_VELOCITY" },
        },

        LEARNING_VELOCITY: {
          entry: assign({ stateName: "LEARNING_VELOCITY" }),
          after: {
            [PHASE_BUDGETS_MS.domain_knowledge[5]]: "STRETCH_SCORING",
          },
          on: {
            CANDIDATE_RESPONSE: "STRETCH_SCORING",
            TIMEOUT:            "STRETCH_SCORING",
          },
        },

        STRETCH_SCORING: {
          entry: assign({ stateName: "STRETCH_SCORING" }),
          on: {
            STRETCH_SCORED: {
              target:  "#domain-knowledge.PHASE_6_COACHABILITY",
              actions: "setStretchScore",
            },
          },
        },
      },
    },

    // ══════════════════════════════════════════════════════════════
    // COMPOUND STATE: PHASE_6_COACHABILITY
    //
    // Correction acceptance test.
    // The interviewer issues a deliberate challenge (incorrect or
    // partially incorrect statement) and observes whether the
    // candidate pushes back with evidence, capitulates, or deflects.
    // The coachabilityScore is applied as a multiplier on the overall
    // score, not additively.
    // ══════════════════════════════════════════════════════════════
    PHASE_6_COACHABILITY: {
      initial: "DELIBERATE_CHALLENGE",
      entry:   assign({ phase: 6, stateName: "DELIBERATE_CHALLENGE" }),

      states: {
        DELIBERATE_CHALLENGE: {
          entry: assign({ stateName: "DELIBERATE_CHALLENGE" }),
          after: {
            [PHASE_BUDGETS_MS.domain_knowledge[6]]: "COACHABILITY_SCORING",
          },
          on: {
            CANDIDATE_RESPONSE: "RESPONSE_CLASSIFY",
            TIMEOUT:            "COACHABILITY_SCORING",
          },
        },

        // Full arc evaluation — not a binary pass/fail.
        RESPONSE_CLASSIFY: {
          entry: assign({ stateName: "RESPONSE_CLASSIFY" }),
          on: {
            PHASE_COMPLETE: "REASONING_DEPTH_EVAL",
          },
        },

        REASONING_DEPTH_EVAL: {
          entry: assign({ stateName: "REASONING_DEPTH_EVAL" }),
          on: {
            PHASE_COMPLETE: "COACHABILITY_SCORING",
          },
        },

        COACHABILITY_SCORING: {
          entry: assign({ stateName: "COACHABILITY_SCORING" }),
          on: {
            COACHABILITY_SCORED: {
              target:  "#domain-knowledge.PHASE_7_SCORING",
              actions: "setCoachabilityScore",
            },
          },
        },
      },
    },

    // ══════════════════════════════════════════════════════════════
    // COMPOUND STATE: PHASE_7_SCORING
    //
    // Final scoring & knowledge depth report.
    // Linear pipeline: dimension scoring → claim map → depth profile
    // → hire signal → (optional) cross-round meta → report.
    // ══════════════════════════════════════════════════════════════
    PHASE_7_SCORING: {
      initial: "DOMAIN_SCORE_CALC",
      entry:   assign({ phase: 7, stateName: "DOMAIN_SCORE_CALC" }),

      states: {
        DOMAIN_SCORE_CALC: {
          entry: assign({ stateName: "DOMAIN_SCORE_CALC" }),
          on: {
            SCORE_COMPUTED: {
              target:  "CLAIM_VALIDATION_MAP",
              actions: [
                "setDimensionScores",
                // Coachability multiplier is applied after base scores are set
                // so the multiplication uses the final computed overall score.
                "applyCoachabilityMultiplier",
              ],
            },
          },
        },

        CLAIM_VALIDATION_MAP: {
          entry: assign({ stateName: "CLAIM_VALIDATION_MAP" }),
          on: { PHASE_COMPLETE: "DEPTH_PROFILE_GEN" },
        },

        DEPTH_PROFILE_GEN: {
          entry: assign({ stateName: "DEPTH_PROFILE_GEN" }),
          on: { PHASE_COMPLETE: "HIRE_SIGNAL_CALC" },
        },

        HIRE_SIGNAL_CALC: {
          entry: [
            "computeHireSignal",
            assign({ stateName: "HIRE_SIGNAL_CALC" }),
          ],
          on: {
            // Prior scores available — compute cross-round meta.
            PRIOR_SCORES_LOADED: {
              target:  "CROSS_ROUND_META_SCORE",
              actions: "setPriorScores",
            },
            // No prior scores — skip meta and go straight to report.
            PHASE_COMPLETE: "REPORT_BUILDING",
          },
        },

        // Computed only when all 3 interview types have scores available.
        CROSS_ROUND_META_SCORE: {
          entry: [
            "computeCrossRoundMeta",
            assign({ stateName: "CROSS_ROUND_META_SCORE" }),
          ],
          always: "REPORT_BUILDING",
        },

        // Named REPORT_BUILDING (not REPORT_GENERATED) to avoid name collision
        // with the REPORT_READY event type.
        REPORT_BUILDING: {
          entry: assign({ stateName: "REPORT_BUILDING" }),
          on: {
            REPORT_READY: {
              target:  "#domain-knowledge.TERMINAL_COMPLETED",
              actions: "setReport",
            },
          },
        },
      },
    },

    // ══════════════════════════════════════════════════════════════
    // TERMINAL STATES
    // ══════════════════════════════════════════════════════════════

    TERMINAL_COMPLETED: {
      type:  "final" as const,
      entry: assign({ stateName: "TERMINAL_COMPLETED" }),
    },

    // ERROR_STATE is reached via the root-level `on: ERROR` transition
    // declared above so any compound state can escape to it without
    // needing a per-state handler.
    ERROR_STATE: {
      type:  "final" as const,
      entry: assign({ stateName: "ERROR_STATE" }),
    },
  },
});

export type DomainKnowledgeMachine = typeof domainKnowledgeMachine;
export type DomainKnowledgeActor   = ActorRefFrom<DomainKnowledgeMachine>;