/**
 * SESSION CONTROLLER — PATCH FILE
 *
 * This file contains the three methods that must replace their counterparts
 * in apps/api/src/services/session-controller.ts:
 *
 *   1. buildPlanContext()       — unchanged, kept for reference
 *   2. buildEvaluationSignals() — NEW: extracts live scores from XState context
 *   3. enrichPlanContext()      — REMOVED: signals now go through typed field,
 *                                 not string concatenation
 *
 * In handleCandidateResponse and runPreSession, every call to
 * generateInterviewerResponse must be updated to pass evaluationSignals.
 *
 * FIND & REPLACE GUIDE
 * ────────────────────
 * Search for every occurrence of:
 *
 *   const enrichedPlanContext = InterviewSessionController.enrichPlanContext(
 *     planContext, newCtx / openingCtx
 *   );
 *
 * Replace with:
 *
 *   const enrichedPlanContext  = InterviewSessionController.buildPlanContext(newCtx / openingCtx);
 *   const evaluationSignals    = InterviewSessionController.buildEvaluationSignals(newCtx / openingCtx);
 *
 * Then pass evaluationSignals into generateInterviewerResponse(..., evaluationSignals).
 *
 * See the two generateInterviewerResponse call patches at the bottom of this file.
 */

import type {
  BehavioralMachineContext,
  DomainKnowledgeMachineContext,
  SystemDesignMachineContext,
} from "@interview/state-machines";
import type { EvaluationSignals } from "@interview/ai-engine";

// ────────────────────────────────────────────────────────────────────────────
// TYPE — mirrors AnyContext from session-controller.ts
// ────────────────────────────────────────────────────────────────────────────

type AnyContext =
  SystemDesignMachineContext &
  BehavioralMachineContext &
  DomainKnowledgeMachineContext & {
    interviewObject?: import("@interview/shared-types").InterviewPlan | null;
    activeProbeIndex?: number;
  };

// ────────────────────────────────────────────────────────────────────────────
// buildPlanContext — no changes to this method
// (kept here for completeness — the body is identical to the original)
// ────────────────────────────────────────────────────────────────────────────

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
  // Domain knowledge
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

// ────────────────────────────────────────────────────────────────────────────
// buildEvaluationSignals — NEW METHOD
//
// Extracts all live evaluation signals from the XState context and returns
// them as a typed EvaluationSignals object.  This is passed directly to
// generateInterviewerResponse so the LLM has full signal to adapt its
// questioning strategy without any string serialization.
//
// The extraction is intentionally defensive (optional chaining + nullish
// coalescing everywhere) because this method is called at every turn, including
// the opening question where most slices are at their zero-value defaults.
// ────────────────────────────────────────────────────────────────────────────

private static buildEvaluationSignals(ctx: AnyContext): EvaluationSignals {
  // ── Domain knowledge signals ──────────────────────────────────────────────
  const dCtx = ctx as DomainKnowledgeMachineContext;
  if (Array.isArray(dCtx.domainPlan) && dCtx.domainPlan.length > 0) {
    return {
      // Phase 1
      conceptualScore:         dCtx.phase1?.conceptualScore            ?? null,
      misconceptionsDetected:  dCtx.phase1?.misconceptionsDetected      ?? [],
      overconfidenceFlag:      dCtx.phase1?.overconfidenceFlag          ?? false,
      underconfidenceFlag:     dCtx.phase1?.underconfidenceFlag         ?? false,
      // Phase 2
      productionDepthScore:    dCtx.phase2?.productionDepthScore        ?? null,
      inflationFlag:           dCtx.phase2?.inflationFlag               ?? false,
      // Phase 3
      depthScore:              dCtx.phase3?.depthScore                  ?? null,
      idkHandled:              dCtx.phase3?.idkHandled                  ?? false,
      adjacentDomainTested:    dCtx.phase3?.adjacentDomainTested        ?? false,
      // Phase 4
      crossDomainLinked:       dCtx.phase4?.crossDomainLinked           ?? false,
      d2ExchangeCount:         dCtx.phase4?.d2ExchangeCount             ?? 0,
      // Phase 5
      firstPrinciplesScore:    dCtx.phase5?.firstPrinciplesScore        ?? null,
      learningApproachScore:   dCtx.phase5?.learningApproachScore       ?? null,
      // Phase 6
      coachabilityScore:       dCtx.phase6?.coachabilityScore           ?? null,
      // Overall
      overallScore:            dCtx.overallScore                        ?? null,
      dimensionScores:         dCtx.dimensionScores                     ?? [],
      // Meta
      totalExchanges:          dCtx.totalExchanges                      ?? 0,
      probeCount:              dCtx.probeCount                          ?? 0,
      redirectCount:           dCtx.redirectCount                       ?? 0,
      silenceEvents:           dCtx.silenceEvents                       ?? 0,
      currentDomain:           dCtx.currentDomain                       ?? 0,
      totalDomains:            dCtx.domainPlan.length,
    };
  }

  // ── Behavioral signals ────────────────────────────────────────────────────
  const bCtx = ctx as BehavioralMachineContext;
  if (Array.isArray(bCtx.competencyPlan) && bCtx.competencyPlan.length > 0) {
    return {
      storyExistenceConfirmed:  bCtx.storyExistenceConfirmed ?? false,
      starComponents:           bCtx.starPartial
        ? {
            situation: bCtx.starPartial.situation ?? 0,
            task:      bCtx.starPartial.task      ?? 0,
            action:    bCtx.starPartial.action    ?? 0,
            result:    bCtx.starPartial.result    ?? 0,
            learning:  bCtx.starPartial.learning,
          }
        : undefined,
      attributionRatio:         bCtx.iWeRatioRaw               ?? undefined,
      overconfidenceFlag:       false,  // not tracked in behavioral context
      underconfidenceFlag:      false,
      adversityScore: bCtx.adversityScore
        ? {
            accountability: bCtx.adversityScore.accountability,
            recoveryArc:    bCtx.adversityScore.recoveryArc,
            noBlame:        bCtx.adversityScore.noBlame,
            learningQuality: bCtx.adversityScore.learningQuality,
          }
        : undefined,
      overallScore:             bCtx.overallScore               ?? null,
      dimensionScores:          bCtx.dimensionScores            ?? [],
      totalExchanges:           bCtx.totalExchanges             ?? 0,
      probeCount:               bCtx.probeCount                 ?? 0,
      redirectCount:            bCtx.redirectCount              ?? 0,
      silenceEvents:            bCtx.silenceEvents              ?? 0,
      currentCompetencyIndex:   bCtx.currentCompetencyIndex     ?? 0,
      totalCompetencies:        bCtx.competencyPlan.length,
    };
  }

  // ── System design signals ─────────────────────────────────────────────────
  const sdCtx = ctx as SystemDesignMachineContext;
  if (sdCtx.interviewObject) {
    return {
      coverageScore:    sdCtx.coverageScore    ?? null,
      estimationScore:  sdCtx.estimationScore  ?? null,
      tradeoffScore:    sdCtx.tradeoffScore    ?? null,
      overallScore:     sdCtx.overallScore     ?? null,
      dimensionScores:  sdCtx.dimensionScores  ?? [],
      totalExchanges:   sdCtx.totalExchanges   ?? 0,
      probeCount:       sdCtx.probeCount       ?? 0,
      redirectCount:    sdCtx.redirectCount    ?? 0,
      silenceEvents:    sdCtx.silenceEvents    ?? 0,
    };
  }

  // ── Fallback (pre-session or unknown type) ────────────────────────────────
  return {
    totalExchanges: ctx.totalExchanges ?? 0,
    probeCount:     ctx.probeCount     ?? 0,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// PATCH 1 — Opening question (inside runPreSession, after finalStateName is set)
//
// REPLACE the existing enrichPlanContext + generateInterviewerResponse block:
//
//   const enrichedPlanContext = InterviewSessionController.enrichPlanContext(
//     planContext, openingCtx
//   );
//   const openingQuestion = await generateInterviewerResponse({
//     interviewType:     input.type,
//     role:              input.role,
//     level:             input.level,
//     currentPhase:      openingCtx.phase,
//     currentState:      finalStateName,
//     transcript:        [],
//     planContext:       enrichedPlanContext,
//     activeProbeIndex:  0,
//     followUpIntensity: "medium",
//   });
//
// WITH:
// ────────────────────────────────────────────────────────────────────────────

/*
const planContext      = InterviewSessionController.buildPlanContext(openingCtx);
const evaluationSignals = InterviewSessionController.buildEvaluationSignals(openingCtx);

const openingQuestion = await generateInterviewerResponse({
  interviewType:      input.type,
  role:               input.role,
  level:              input.level,
  currentPhase:       openingCtx.phase,
  currentState:       finalStateName,
  transcript:         [],
  planContext,
  activeProbeIndex:   0,
  followUpIntensity:  "medium",
  evaluationSignals,
});
*/

// ────────────────────────────────────────────────────────────────────────────
// PATCH 2 — Subsequent turns (inside handleCandidateResponse, step 6)
//
// REPLACE the existing block:
//
//   const enrichedPlanContext = InterviewSessionController.enrichPlanContext(
//     planContext, newCtx
//   );
//   interviewerResponse = await generateInterviewerResponse(
//     {
//       interviewType:     typeRegistry.get(sessionId) ?? "system_design",
//       role:              newCtx.role,
//       level:             newCtx.level,
//       currentPhase:      newCtx.phase,
//       currentState:      newStateName,
//       transcript:        transcript.map((t) => ({ role: t.role, content: t.content })),
//       planContext:       enrichedPlanContext,
//       activeProbeIndex:  newCtx.activeProbeIndex ?? 0,
//       followUpIntensity: (newCtx as BehavioralMachineContext).followUpIntensity ?? "medium",
//     },
//     onChunk
//   );
//
// WITH:
// ────────────────────────────────────────────────────────────────────────────

/*
const planContext       = InterviewSessionController.buildPlanContext(newCtx);
const evaluationSignals = InterviewSessionController.buildEvaluationSignals(newCtx);

interviewerResponse = await generateInterviewerResponse(
  {
    interviewType:      typeRegistry.get(sessionId) ?? "system_design",
    role:               newCtx.role,
    level:              newCtx.level,
    currentPhase:       newCtx.phase,
    currentState:       newStateName,
    transcript:         transcript.map((t) => ({ role: t.role, content: t.content })),
    planContext,
    activeProbeIndex:   newCtx.activeProbeIndex ?? 0,
    followUpIntensity:  (newCtx as BehavioralMachineContext).followUpIntensity ?? "medium",
    evaluationSignals,
  },
  onChunk
);
*/

// ────────────────────────────────────────────────────────────────────────────
// REMOVE enrichPlanContext and buildResumeEvidence from the class entirely.
// They are replaced by buildEvaluationSignals which passes signals as typed
// fields rather than string-concatenating them into planContext.
// ────────────────────────────────────────────────────────────────────────────