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
// CONTEXT
// ============================================================

export interface DomainKnowledgeMachineContext extends SharedContext {
  domainPlan: DomainPlan[];
  currentDomain: 0 | 1 | 2;

  // Phase 1 — Conceptual
  conceptualScore: number;
  misconceptionsDetected: string[];
  overconfidenceFlag: boolean;
  underconfidenceFlag: boolean;

  // Phase 2 — Applied
  productionDepthScore: number;
  inflationFlag: boolean;
  claimValidationMap: ClaimValidation[];

  // Phase 3 — Edge case
  depthScore: number;
  idkHandled: boolean;
  adjacentDomainTested: boolean;

  // Phase 4 — Domain 2
  domain2Score: number;
  domain2DepthType: "deep" | "broad" | null;
  crossDomainLinked: boolean;
  d2RedirectIssued: boolean;

  // Phase 5 — Domain 3 stretch
  stretchScore: number; // Weighted 0.5x
  firstPrinciplesScore: number;
  learningApproachScore: number;

  // Phase 6 — Correction acceptance
  coachabilityScore: number;

  // Cross-round
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
  | { type: "PLAN_GENERATED"; plan: DomainPlan[] }
  | { type: "QUALITY_GATE_PASS" }
  | { type: "QUALITY_GATE_FAIL" }
  | { type: "CANDIDATE_READY" }
  | { type: "CANDIDATE_RESPONSE" }
  | { type: "MISCONCEPTION_DETECTED"; misconception: string }
  | { type: "CONFIDENCE_ASSESSED"; overconfident: boolean; underconfident: boolean }
  | { type: "CONCEPTUAL_SCORED"; score: number }
  | { type: "PROD_SIGNAL_DETECTED"; hasProdSignal: boolean }
  | { type: "TUTORIAL_OR_PROD_CLASSIFIED"; depth: number; inflation: boolean }
  | { type: "CLAIM_VALIDATED"; validation: ClaimValidation }
  | { type: "IDK_HANDLED" }
  | { type: "ADJACENT_DOMAIN_TESTED" }
  | { type: "DEPTH_SCORED"; score: number }
  | { type: "CROSS_DOMAIN_LINKED" }
  | { type: "D2_REDIRECT_NEEDED" }
  | { type: "D2_SCORED"; score: number; depthType: "deep" | "broad" }
  | { type: "STRETCH_SCORED"; firstPrinciples: number; learning: number }
  | { type: "COACHABILITY_SCORED"; score: number }
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
// MACHINE
// ============================================================

export const domainKnowledgeMachine = setup({
  types: {
    context: {} as DomainKnowledgeMachineContext,
    events: {} as DkEvent,
    input: {} as DomainKnowledgeMachineInput,
  },

  actions: {
    // ── Shared actions: each impl is a plain property-assigner object from
    //    shared.ts; wrapping in assign() here binds it to this machine's
    //    context type so XState's variance probe resolves correctly.
    incrementExchanges:          assign(SHARED_ACTION_IMPLS.incrementExchanges),
    incrementSilenceEvents:      assign(SHARED_ACTION_IMPLS.incrementSilenceEvents),
    incrementProbeCount:         assign(SHARED_ACTION_IMPLS.incrementProbeCount),
    incrementRedirectCount:      assign(SHARED_ACTION_IMPLS.incrementRedirectCount),
    incrementQualityGateRetries: assign(SHARED_ACTION_IMPLS.incrementQualityGateRetries),
    advancePhase:                assign(SHARED_ACTION_IMPLS.advancePhase),
    clearError:                  assign(SHARED_ACTION_IMPLS.clearError),

    // ── Machine-specific actions ──────────────────────────────

    setDomainPlan: assign({
      domainPlan: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "PLAN_GENERATED" }>;
        return e.plan;
      },
    }),

    setConfidenceFlags: assign({
      overconfidenceFlag: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "CONFIDENCE_ASSESSED" }>;
        return e.overconfident;
      },
      underconfidenceFlag: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "CONFIDENCE_ASSESSED" }>;
        return e.underconfident;
      },
    }),

    recordMisconception: assign({
      misconceptionsDetected: ({ context, event }) => {
        const e = event as Extract<DkEvent, { type: "MISCONCEPTION_DETECTED" }>;
        return [...context.misconceptionsDetected, e.misconception];
      },
    }),

    setConceptualScore: assign({
      conceptualScore: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "CONCEPTUAL_SCORED" }>;
        return e.score;
      },
    }),

    setProductionDepth: assign({
      productionDepthScore: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "TUTORIAL_OR_PROD_CLASSIFIED" }>;
        return e.depth;
      },
      inflationFlag: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "TUTORIAL_OR_PROD_CLASSIFIED" }>;
        return e.inflation;
      },
    }),

    recordClaimValidation: assign({
      claimValidationMap: ({ context, event }) => {
        const e = event as Extract<DkEvent, { type: "CLAIM_VALIDATED" }>;
        return [...context.claimValidationMap, e.validation];
      },
    }),

    setDepthScore: assign({
      depthScore: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "DEPTH_SCORED" }>;
        return e.score;
      },
    }),

    markIdkHandled: assign({ idkHandled: true }),

    markAdjacentDomainTested: assign({ adjacentDomainTested: true }),

    markCrossDomainLinked: assign({ crossDomainLinked: true }),

    setD2Score: assign({
      domain2Score: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "D2_SCORED" }>;
        return e.score;
      },
      domain2DepthType: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "D2_SCORED" }>;
        return e.depthType;
      },
    }),

    issueD2Redirect: assign({
      d2RedirectIssued: true,
      redirectCount: ({ context }) => context.redirectCount + 1,
    }),

    setStretchScore: assign({
      firstPrinciplesScore: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "STRETCH_SCORED" }>;
        return e.firstPrinciples;
      },
      learningApproachScore: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "STRETCH_SCORED" }>;
        return e.learning;
      },
      // Stretch is weighted 0.5x — no correctness component
      stretchScore: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "STRETCH_SCORED" }>;
        return ((e.firstPrinciples + e.learning) / 2) * 0.5;
      },
    }),

    setCoachabilityScore: assign({
      coachabilityScore: ({ event }) => {
        const e = event as Extract<DkEvent, { type: "COACHABILITY_SCORED" }>;
        return e.score;
      },
    }),

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

    // Coachability acts as a multiplier, not additive
    applyCoachabilityMultiplier: assign({
      overallScore: ({ context }) =>
        context.overallScore !== null
          ? context.overallScore * context.coachabilityScore
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
    // Shared guards are plain predicate functions — spread directly, no wrapping needed.
    ...sharedGuards,

    hasOverconfidenceFlag: ({ context }) => context.overconfidenceFlag,

    d2NeedsRedirect: ({ event }) => event.type === "D2_REDIRECT_NEEDED",
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QQPYFsCGBLAdgWgGscUB3AG0hgDoBJAEQBkBRAYgGUAVAQQCUOB9NkzZsaAeQByAbQAMAXUSgADilhYALlhQ5FIAB6IATIYCsVEwE4rADkMyZhgGwBmAOyvDAGhABPRAEYZABYqR3tDf0drZ2dow2cTAF9E71RMXEJickowKjoxAFkuGgl+bgANSUKATX4GMS46FhKABQBVDjZ+Ft4hOlkFJBAVNU1tXQMERyDHKhnDIJMgoOcZVzdrbz8EQJCwh0jo2Od4pJSQNOx8IlIKaFyeYTaCpn58opLu3tYWgAkuIT8ADChRazA4TAGuhGGi0OiGk0ClioCxsJncFn8iy2AWCoXChxicQSyVS6CumVuOTyhWKpTBXFKAHEmBIWAzmaymDwuBD+vJoapYeMEQFDBZDFR-KYZCZrOt-HLXI4cTsllRVjJIq5rPZ5cEgqSLuSMjdsvcqABFNpcBg0Di1Jm81jW232x3Or4iKFDGFjeGgRGyiwooJojFYkyqxbOUImexrXUWGTTM5k9LXLJ3aiuu0O-hOiEsXPuguegBixQYPuUQv9E1xyNRFms6NcmOxvkQCVcKITjn8-mcFkco7TxozlPNOZteY9RZL+cLr0rNGr-kGtdGcIbO2DofD7cjqplVFc8cHy1cDiiQVcRsupqz1I5-EejWqLCBjLo9E977oaoa2GOsd1FHYol7IIZWcMJHA8IdVWHMxHBlJxnH8CwdVlcdH0zKkLRBCQgSYFoOFnfhrWEDhxDZb8JF-Oh-2EFpJCEYC-TAwMjEHfw5njFMghkCVr1bJDrD4oTokHJx-GsRwlgfE18OnXIiJIsiKKozhaJYGiXjEDoONAkVuIQCJB34+xpmEwxRKjLsEBMYcpRkVtglsKJLEMJTJzNbNcgKGg2HU0iaMkN4mAhIEOBYIKQskDTwtKOgoqYGKmH5TcQO3Uz9CME4Q0MeU5QWOynFcIIT1cPjRIWQrnCCawLFw5SpwCqh4tCsjaMi6LYr+AFXhBAowTS4zcoDfLzLlWM5OVNZitWYqkJHfjoksBSMKHeTfIpfzqSI8t6FZEjgTdAAhHkiyOk7iNeAEhBETKJuFKbJnFLC5hKlsW1QnVxOsKUYkKoc3KiPanwI6huvI21BBBHgSiZL9ErCiiEseLLBUm3dGuWPstTkrzMOVQHgZicUwfk6xIZUjquBaMEaEyyi2mo3T6MY5i2FYiR2IFX0TPe7tWxCYwTEVYSTBMMJXFW3sqccCU-qvHzzjw9rqUZ5nWe05K9JoAyjMFrc3rxsWUVMKWWtltZVSWPitVHUcTkvVC6a1i0Wh4MQ6EEGgmQkeHUv69l-kBEaxohV763A6D5TPaVIOsRZNoVlFMWV8V5LVz2DotAB1XhBA4MQeFqH2xAu1gub-CE3xYtjIVNnLzfj0de2lSXZZHFs3IzpWVdzu91fTfbnwtciy6R+GADUuir-2gQYR6aHLT9p-Lmh4fL7pfeX1eRHXlnsaF3HwJ72MZUVJrStMJD1ioLPlclhIKrHicJ+htTV6N-g55uiYgbFexQCgAKAc6M+Zs45mSWC5CwbgByoSsMECwJ4WpSm1KJNY2pP6awLjDP+4DAF2mAbpQakdQTghbtlTieVJiywSBqa2ThEGDjlNGTCVB5KjhWFhFsTVIj50ntQTKLJzqAn1pzH89dXiPF5s3WOXFpphGYZBOWA55KIUckJFCYZU46k2vNERP8qDiOGkNNmHNJCG2NhwZRDDEBqJQvKTRxMdHbDCEDeI4p1jNXiCmfBbVCGBWCrDXqCixAMA6BQiOw1qHjVbvQkWUwTDFUJoEOWsFojRllKEAxd5WwjhMRrEJojcj0AANL8H+AxO0EgUbVNqT+Zg0C26wNUfKIGmo1hWCHLBaMQQ+IDPCNeaY5VTGqVoHQGpdTGDI3DlYqONDHGpJThqBM7ZMQxBVI5YckkYiyn8OsRBzVhFlL8hUqgjQABSXASISAEO8OkZRqJflkcA+RTd+a0Jxu3My6xJahG7jqTCMsHBDL4iOFwsEZDDgWrLKZDM6D3Mec82knwIScBYHch5rIMUfFKNivkazdxAr4gOUwYLbaQv2RKFErt3IeA8Ase8lzv7TNSmRX4CNt6NJYNyjgvLMYvWScLclupYx3njC4Fw14sSrUkq7WIEQwwrEWMi6kdBDD8HLPUQuyNgSSDnmID5DE5GN0Ub8sl4FbDxjmKhJYlVKouCqo5eCIRnJylQnBE5u0OVQy5bq-VYhDWNONRIU1grdVYxoI8GK-AJBMEymKuhEq7WnnmM6u8MxGrRgWBqAcsQdQyqao4LVFodV6oNUaoi0b9JMEMg48VF8zL2pkI60wubXX5t0ZVKgKYBnWAkosXhzhK0w19iIN4mLSgNKqV+adXQXmfAXWm-5nTJiGJ6f2OUwlMLOAdjVLBg5ojFtThc8eQaOpAmXbOoldQSiLsoQk0aqzW0AumrYVOZ4nVuMPUexymIzCnAkj2N28FJ25GrT0IEizq1xoTQIZNqb2kpMlfCuY54UywTcFqd12wmq9izsVJqqdGqKmg3kXVcHFmvuNe+pJ6a23TWwtKnDcr8OKscs5XsyCwNv3bK1K5ZjYMPMWY25ttrAVSuw7KvDCrCOIHbCEEds1dTNWVsqajiHMrxvSgNeJjHo5-PPl+7dZG-2mAA4goD2w3B7AHCsKIupJbBBE5yjq1bMYId1aK9DGb23jOfgJFqpgZbuGjApM8eG3LiniEJdl176bUk4I8DgQJeXlh5EFAVdcvlWr5gLFjFnEDJgQeeGSHgwjQWjM1U9qxnPvxTBWwNqWLTHR4JwfeJR4NjS6CS813MG4KOK2ZmBKjJgWDvCGKWioTgy3C-Vubg4mtYha6OajzBeASCNXPJg9R4MOmG5asbSjP1bvK8mEZbjil2EiA7QtlhlhhFQaDbbTBdv7cO2IY7m8jZNpNqVq7CBUG3eVPd520YB3NUWIEBwoNZTUfS1FLLfKkYCtR5lkViMN3mdB4EDCna7Bamkk4Ue0XZi91mxeDzaxdOHZoDXa6w1-gMGYI02unyebjZk9NQICFB32BOTJalmx+1mBZRRhIo56ptZS17agqU7Qs89Fl20nOWR2KBy2kHU3cRC4TKL6U4vVRaI1DqeIouFQnGo+d35wIj6iA3ksqhTGY6XYNzsS8naR2Q8W41dBkuzx2Rl7LVCLn7dfbYJII1QreVMFIW7t9pn+eIkVAOLBTgnXwRcA5Ij55Q+lpiBH+X1GQQPP+BdNcpZfP5YaBrmvc4Mf48m04n3WFezwuVPu2XMxotQQcFhMMlh7DrENO1pXMG52t-OgwIE7A8cmY6G3jp3vpTDK9cnHUYK3BeF0c5OYdkbCpxHRqhXX8b2HWIRAshvJepFBaCnkzH79cd+lPKbfThWyBAP0R5MM8DEDwCSMndYRnHlfeMQY6ZgAsVkF-FZZjTdDfE4VCYGSHYwG8eFaMQA9wdsEAwIeaCdKfUJKgX4AzAOIOeGb8BfdkJGPeUVLoeoRoNfDDcCIcW8QdX1VCYwSqO8IZIGVsMjASYqBYKjEg65cgx4Sg4OBgefRfBjRAz3d-VJDg39IJOXXgq8c3OyHhPAvNcteCWmCQsxO9MQGdX2NoBifgF4bgVvFgdPAIYZeSVyLUCUFYE4DwGHWMaXaCGnZMCwaPViPgfgC6NoNcX8AVR4YIgQACICL3D-ZYZEOXVzOyIJaLWMZMYqaUGIE5OUZIc4YgCAOAXQAhCpZAjvPAPZbYKo4XBMeo+orEajegZgCo1Ja8UIG+WUaYeHMMVUCSTZYfeFVYJYTEQIkwrlWfCoKoAoWoZgugNovGNaTCKwZyS8E4foviXpO8DbOCLUaPNgZ4V4Vdekb4RYzNTtWCNleIAcHUKITYwY4IGqFzFMfYiY7zWfV8FkCQc4syLETERlUwbTYSISBSVUP-To9JYZE4ZCYfajRcecJgX479ROFsF1dwF7VYCXbYIEjUGWSIVCRUdJdESfRXUg18OI5ExEeMWMRbFMXURUGbME-ZDwFheMGwSIMMdYS-Mo0wtGTSeGaRSQKkgIc-KUEqJYZYImHjBzVkk4O+OXW2aCajLqfk5KPqQzEU8yRqTtebYICIfUeUR+OaOUOSKwVCf3Tza-QiSQY6VKe6efZnVnLUuyE9DweMMWEA5qcmOwVOewIpZUO8Hk8pPk+6AUuQ+vJkLUk4UwZ+JBNBaEhIZTBAWIHxNyISJ4txIM6jHWO0PWdmHSYUgnb3WCNA9yLEe7dJYPBzEdPsP0zMwMnTd4l8A+GQkONKGKLUpLbvbglWZ2ao7sJ+fpdJQqHg8GajYuHgUucuSuX2GuLsoMlEC8UceFJYWWAvQczIzEYqLUWydwTVZsqeDobeeeReVs0BY+DeLskdEMEcCqZyYIWCeWFkrck5PhaSCZZLK-DrIhMBO-euWiLUyUyUHvX1RUcqas7sNaCPGqF1BSBSJwajCxSRV4IUn44sjvUqWMeSJwY5CIMnDclM6CuXbaG8HUcYsk65VUsM9UqJGJZKLU-9cwVhSwNYmqQi1VPE4INYdYBwYwYJUTaZZpeZBpKMjC9ZGqWYdYc8VOdCSU8SSUIPDVFsBYMMHM1FfFJ5B9V5ElLU8ZWYaIc8U0+FTAjigdSWCZJqdhGEq0n8mDMKXHflMS9vdongjUNwGWYZeCWUZ8hzAEx2ISFqC0vRXTENWtCNetMQLUqVTtbNNYzaFYPJanTEWUCna2ZWYMwS29e9E4p9CQKpaKqyqUf9BaXDQi+CSUWWNbBwYkLCUKr4eDRpPS2FcwBMCUTCEdFaXjQtVOMfQSN1JsyisTWNfTZDQqhrSIGzUq-PE8RYHhWCO+AZf1VseqyM6K2VbDCUMfc8SqaLMwCSIcdsGyeIdwFHDgDLdHHLLgPLZy9fDvdTTtO8t7dJSqB+XRGLUA5qVA-PIcUk786fKgLrHrH2PrGgAbN5TgLUiUMs5OYnPY--RAGYfas9FcrETfFMT7b7CNA7I7d0KGhVZ+Nxdi5MSWBGhAJGnhQIL6nPBIYSM6i6xyzHW6tgv4rUQtBwdJfU51MmmYWYHoiFM-GbCIRnVXbkdXdnLXJE8S3cXYNaZUCqCSZBTEKnApNOdMuHYWw86gB3SOZ3deaoLUwIGbbCpBOHdEQ66MdJY-SqVYWbRYGYP63k6Zd8WPPbCNBPfgJPW0Q2occUY-CyrEDwwixYSUBOISGM1lHUCvRvavWvfMNa6W9gk5MMOMAjNYEkkcQfbDIyqwI5N83TWfUVeQw2zAtTHfBYHvbExG+CbDXUPNFMZMZYCvW-UhACiKJ-EunouYEXEpPDAfd6qCbCeu5WeFRBCA4VKAmA14b4w2prWMWUZ2UGeSLOopYIFwBu0e4goa6ZKQ14UQKguQmgoEWexYTteCCy0ehYaYS2kIO8Iy2SnuPPCve9Sw6w2wrgVvWenZdA0cRWwqXyxG5hESDsWS4pR2kM520icuAQMIiI5GQ26CZUcweMOwUY6yezauzI9wEdJ8kcTyzKrzakCEHgPLagxJPkBBlBFEO7FqJqNwfwaLSUaXQyuSFMcZJCngX2KczgZ0Lssm4mfEewY24IBbNrZIIAA */
  id: "domain-knowledge",
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
    domainPlan: [],
    currentDomain: 0,
    conceptualScore: 0,
    misconceptionsDetected: [],
    overconfidenceFlag: false,
    underconfidenceFlag: false,
    productionDepthScore: 0,
    inflationFlag: false,
    claimValidationMap: [],
    depthScore: 0,
    idkHandled: false,
    adjacentDomainTested: false,
    domain2Score: 0,
    domain2DepthType: null,
    crossDomainLinked: false,
    d2RedirectIssued: false,
    stretchScore: 0,
    firstPrinciplesScore: 0,
    learningApproachScore: 0,
    coachabilityScore: 1, // Neutral multiplier until computed
    priorSdScore: input.priorSdScore ?? null,
    priorBehavioralScore: input.priorBehavioralScore ?? null,
    crossRoundMetaScore: null,
    depthProfile: null,
  }),

  states: {
    IDLE: {
      entry: assign({ stateName: "IDLE" }),
      on: { START_SESSION: "DOMAIN_TAXONOMY_LOAD" },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 0 — Pre-session domain extraction
    // ──────────────────────────────────────────────────────────
    DOMAIN_TAXONOMY_LOAD: {
      entry: assign({ stateName: "DOMAIN_TAXONOMY_LOAD", phase: 0 }),
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
          target: "QUALITY_GATE",
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
            // Max retries reached — proceed anyway to avoid infinite loop
            guard: "qualityGateMaxRetriesReached",
            target: "PLAN_READY",
            actions: "incrementQualityGateRetries",
          },
          {
            // Retry plan generation
            target: "DOMAIN_PLAN_GEN",
            actions: "incrementQualityGateRetries",
          },
        ],
      },
    },

    PLAN_READY: {
      entry: assign({ stateName: "PLAN_READY" }),
      on: { CANDIDATE_READY: "CONCEPTUAL_QUESTION" },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 1 — Conceptual foundation (Domain 1)
    // ──────────────────────────────────────────────────────────
    CONCEPTUAL_QUESTION: {
      entry: assign({ stateName: "CONCEPTUAL_QUESTION", phase: 1 }),
      after: {
        [PHASE_BUDGETS_MS.domain_knowledge[1]]: "CONFIDENCE_CALIBRATE",
      },
      on: {
        CANDIDATE_RESPONSE: "MISCONCEPTION_DETECT",
        TIMEOUT: "CONFIDENCE_CALIBRATE",
      },
    },

    MISCONCEPTION_DETECT: {
      entry: assign({ stateName: "MISCONCEPTION_DETECT" }),
      on: {
        // Record misconception and stay in state (deferred — confronted in Phase 3)
        MISCONCEPTION_DETECTED: {
          target: "MISCONCEPTION_DETECT",
          actions: "recordMisconception",
        },
        PHASE_COMPLETE: "CONFIDENCE_CALIBRATE",
      },
    },

    CONFIDENCE_CALIBRATE: {
      entry: assign({ stateName: "CONFIDENCE_CALIBRATE" }),
      on: {
        CONFIDENCE_ASSESSED: {
          target: "CONCEPTUAL_SCORING",
          actions: "setConfidenceFlags",
        },
      },
    },

    CONCEPTUAL_SCORING: {
      entry: assign({ stateName: "CONCEPTUAL_SCORING" }),
      on: {
        CONCEPTUAL_SCORED: {
          target: "APPLIED_QUESTION",
          actions: "setConceptualScore",
        },
      },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 2 — Applied experience probe (Domain 1)
    // ──────────────────────────────────────────────────────────
    APPLIED_QUESTION: {
      entry: assign({ stateName: "APPLIED_QUESTION", phase: 2 }),
      after: {
        [PHASE_BUDGETS_MS.domain_knowledge[2]]: "CLAIM_VALIDATION",
      },
      on: {
        CANDIDATE_RESPONSE: "PROD_SIGNAL_DETECT",
        TIMEOUT: "CLAIM_VALIDATION",
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
          target: "CLAIM_VALIDATION",
          actions: "setProductionDepth",
        },
      },
    },

    CLAIM_VALIDATION: {
      entry: assign({ stateName: "CLAIM_VALIDATION" }),
      on: {
        // Accumulate validations and stay in state until PHASE_COMPLETE
        CLAIM_VALIDATED: {
          target: "CLAIM_VALIDATION",
          actions: "recordClaimValidation",
        },
        PHASE_COMPLETE: "EDGE_CASE_QUESTION",
      },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 3 — Edge case & limits (Domain 1)
    // ──────────────────────────────────────────────────────────
    EDGE_CASE_QUESTION: {
      entry: assign({ stateName: "EDGE_CASE_QUESTION", phase: 3 }),
      after: {
        [PHASE_BUDGETS_MS.domain_knowledge[3]]: "DEPTH_SCORING",
      },
      on: {
        CANDIDATE_RESPONSE: "MISCONCEPTION_RESOLUTION",
        TIMEOUT: "DEPTH_SCORING",
      },
    },

    MISCONCEPTION_RESOLUTION: {
      // Deferred misconceptions from Phase 1 are confronted here
      entry: assign({ stateName: "MISCONCEPTION_RESOLUTION" }),
      on: { PHASE_COMPLETE: "IDK_HANDLING" },
    },

    IDK_HANDLING: {
      entry: assign({ stateName: "IDK_HANDLING" }),
      on: {
        IDK_HANDLED: {
          target: "ADJACENT_DOMAIN_TEST",
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
          target: "D2_FLOWING_CONVO",
          actions: "setDepthScore",
        },
      },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 4 — Domain 2 (compressed, 12 min budget)
    // ──────────────────────────────────────────────────────────
    D2_FLOWING_CONVO: {
      entry: assign({ stateName: "D2_FLOWING_CONVO", phase: 4 }),
      after: {
        [PHASE_BUDGETS_MS.domain_knowledge[4]]: "D2_SCORING",
      },
      on: {
        CANDIDATE_RESPONSE: "CROSS_DOMAIN_LINK",
        D2_REDIRECT_NEEDED: "D2_REDIRECT",
        TIMEOUT: "D2_SCORING",
      },
    },

    CROSS_DOMAIN_LINK: {
      entry: assign({ stateName: "CROSS_DOMAIN_LINK" }),
      on: {
        // Accumulate cross-domain links and stay in state
        CROSS_DOMAIN_LINKED: {
          target: "CROSS_DOMAIN_LINK",
          actions: "markCrossDomainLinked",
        },
        PHASE_COMPLETE: "D2_PACING",
      },
    },

    D2_PACING: {
      entry: assign({ stateName: "D2_PACING" }),
      on: {
        D2_REDIRECT_NEEDED: "D2_REDIRECT",
        PHASE_COMPLETE: "D2_FLOWING_CONVO",
        TIMEOUT: "D2_SCORING",
      },
    },

    D2_REDIRECT: {
      entry: [
        "issueD2Redirect",
        assign({ stateName: "D2_REDIRECT" }),
      ],
      on: {
        PHASE_COMPLETE: "D2_FLOWING_CONVO", // Resume D2 after redirect
      },
    },

    D2_SCORING: {
      entry: assign({ stateName: "D2_SCORING" }),
      on: {
        D2_SCORED: {
          target: "STRETCH_FRAMING",
          actions: "setD2Score",
        },
      },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 5 — Domain 3 (stretch probe, 0.5x weight)
    // ──────────────────────────────────────────────────────────
    STRETCH_FRAMING: {
      entry: assign({ stateName: "STRETCH_FRAMING", phase: 5 }),
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
        TIMEOUT: "STRETCH_SCORING",
      },
    },

    STRETCH_SCORING: {
      entry: assign({ stateName: "STRETCH_SCORING" }),
      on: {
        STRETCH_SCORED: {
          target: "DELIBERATE_CHALLENGE",
          actions: "setStretchScore",
        },
      },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 6 — Correction acceptance test
    // ──────────────────────────────────────────────────────────
    DELIBERATE_CHALLENGE: {
      entry: assign({ stateName: "DELIBERATE_CHALLENGE", phase: 6 }),
      after: {
        [PHASE_BUDGETS_MS.domain_knowledge[6]]: "COACHABILITY_SCORING",
      },
      on: {
        CANDIDATE_RESPONSE: "RESPONSE_CLASSIFY",
        TIMEOUT: "COACHABILITY_SCORING",
      },
    },

    RESPONSE_CLASSIFY: {
      entry: assign({ stateName: "RESPONSE_CLASSIFY" }),
      on: {
        // Full arc evaluation, not binary pass/fail
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
          target: "DOMAIN_SCORE_CALC",
          actions: "setCoachabilityScore",
        },
      },
    },

    // ──────────────────────────────────────────────────────────
    // PHASE 7 — Scoring & knowledge depth report
    // ──────────────────────────────────────────────────────────
    DOMAIN_SCORE_CALC: {
      entry: assign({ stateName: "DOMAIN_SCORE_CALC", phase: 7 }),
      on: {
        SCORE_COMPUTED: {
          target: "CLAIM_VALIDATION_MAP",
          actions: [
            "setDimensionScores",
            "applyCoachabilityMultiplier", // Multiplier applied after base scores are set
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
        // Load prior scores for cross-round meta synthesis
        PRIOR_SCORES_LOADED: {
          target: "CROSS_ROUND_META_SCORE",
          actions: "setPriorScores",
        },
        PHASE_COMPLETE: "REPORT_BUILDING", // No prior scores available — skip meta
      },
    },

    // Cross-round meta: computed only when all 3 interview types are done
    CROSS_ROUND_META_SCORE: {
      entry: [
        "computeCrossRoundMeta",
        assign({ stateName: "CROSS_ROUND_META_SCORE" }),
      ],
      always: "REPORT_BUILDING",
    },

    // Named REPORT_BUILDING (not REPORT_GENERATED) to avoid collision with
    // the REPORT_READY event type.
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

export type DomainKnowledgeMachine = typeof domainKnowledgeMachine;
export type DomainKnowledgeActor = ActorRefFrom<DomainKnowledgeMachine>;