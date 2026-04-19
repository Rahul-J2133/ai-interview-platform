/**
 * Shared state machine utilities.
 *
 * IMPORTANT — XState v5 assign() type constraint:
 * assign() calls are typed against the setup() block they appear in.
 * There is no way to pre-build assign() actions outside a setup() and
 * spread/extend them into another machine — TypeScript's variance probe
 * (_out_TEvent) will always reject them.
 *
 * Pattern: export SHARED_ACTION_IMPLS as plain property-assigner objects.
 * Each machine re-wraps them in assign() inside its own setup() block.
 * This keeps the logic in one place without duplicating it.
 */

import type {
  DimensionScore,
  HireSignal,
  InterviewReport,
  CrossRoundMetaScore,
} from "@interview/shared-types";

// ============================================================
// SHARED CONTEXT
// ============================================================

export interface SharedContext {
  sessionId: string;
  userId: string;
  role: string;
  tier: "T1" | "T2" | "T3";
  level: "junior" | "mid" | "senior" | "staff" | "principal";
  phase: number;
  stateName: string;
  silenceTimerMs: number;
  qualityGateRetries: number;
  totalExchanges: number;
  silenceEvents: number;
  probeCount: number;
  redirectCount: number;
  errorMessage: string | null;
  dimensionScores: DimensionScore[];
  hireSignal: HireSignal | null;
  overallScore: number | null;
  report: InterviewReport | null;
}

// ============================================================
// CONSTANTS
// ============================================================

export const SILENCE_THRESHOLD_MS = 15_000;
export const QUALITY_GATE_MAX_RETRIES = 2;

export const PHASE_BUDGETS_MS = {
  system_design: {
    0: 120_000,
    1: 60_000,
    2: 480_000,
    3: 300_000,
    4: 600_000,
    5: 480_000,
    6: 300_000,
    7: 180_000,
  },
  behavioral: {
    0: 120_000,
    1: 180_000,
    2: 720_000,
    3: 720_000,
    4: 720_000,
    5: 300_000,
    6: 180_000,
  },
  domain_knowledge: {
    0: 120_000,
    1: 480_000,
    2: 480_000,
    3: 480_000,
    // 4: 720_000,
    4: 60_000,    // 12-minute timer is too long for a test/dev environment
    5: 600_000,
    6: 300_000,
    7: 180_000,
  },
} as const;

// ============================================================
// SHARED ACTION IMPLEMENTATIONS
//
// These are plain property-assigner objects — NOT wrapped in assign().
// Each machine passes them to assign() inside its own setup() block
// so XState resolves the types correctly.
//
// Usage in each machine:
//   import { SHARED_ACTION_IMPLS } from "../shared";
//   const sd = setup({
//     actions: {
//       incrementExchanges: assign(SHARED_ACTION_IMPLS.incrementExchanges),
//       ...
//     }
//   });
// ============================================================

export const SHARED_ACTION_IMPLS = {
  incrementExchanges: {
    totalExchanges: ({ context }: { context: SharedContext }) =>
      context.totalExchanges + 1,
  },
  incrementSilenceEvents: {
    silenceEvents: ({ context }: { context: SharedContext }) =>
      context.silenceEvents + 1,
  },
  incrementProbeCount: {
    probeCount: ({ context }: { context: SharedContext }) =>
      context.probeCount + 1,
  },
  incrementRedirectCount: {
    redirectCount: ({ context }: { context: SharedContext }) =>
      context.redirectCount + 1,
  },
  incrementQualityGateRetries: {
    qualityGateRetries: ({ context }: { context: SharedContext }) =>
      context.qualityGateRetries + 1,
  },
  advancePhase: {
    phase: ({ context }: { context: SharedContext }) => context.phase + 1,
  },
  clearError: {
    errorMessage: (): null => null,
  },
} as const;

// ============================================================
// SHARED GUARDS
// ============================================================

export const sharedGuards = {
  qualityGateMaxRetriesReached: ({ context }: { context: SharedContext }) =>
    context.qualityGateRetries >= QUALITY_GATE_MAX_RETRIES,

  hasError: ({ context }: { context: SharedContext }) =>
    context.errorMessage !== null,
};

// ============================================================
// HIRE SIGNAL CALCULATOR
// ============================================================

export function calcHireSignal(
  score: number,
  tier: "T1" | "T2" | "T3"
): HireSignal {
  const adjusted = tier === "T1" ? score - 0.05 : score;
  if (adjusted >= 0.85) return "strong_hire";
  if (adjusted >= 0.65) return "hire";
  if (adjusted >= 0.45) return "no_hire";
  return "strong_no_hire";
}

// ============================================================
// CROSS-ROUND META SCORE
// ============================================================

export function calcCrossRoundMetaScore(
  sdScore: number | null,
  behavioralScore: number | null,
  domainScore: number | null,
  tier: "T1" | "T2" | "T3"
): CrossRoundMetaScore {
  const available = [sdScore, behavioralScore, domainScore].filter(
    (s): s is number => s !== null
  );
  const minScore = available.length > 0 ? Math.min(...available) : 0;
  return {
    systemDesignScore: sdScore,
    behavioralScore,
    domainKnowledgeScore: domainScore,
    finalHireSignal: calcHireSignal(minScore, tier),
    computedAt: new Date(),
  };
}