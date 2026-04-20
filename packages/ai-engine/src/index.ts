/**
 * packages/ai-engine/src/index.ts
 *
 * All AI calls go through this module.
 * - Groq replaces Anthropic entirely.
 * - Every public function has explicit parameter and return types.
 * - No unused imports.
 * - env vars are read lazily (inside functions, not at module scope)
 *   so this package can be imported without crashing if GROQ_API_KEY
 *   is not yet set at module evaluation time.
 */

// import "../lib/env"; // FIRST — loads dotenv before any package initialises

import Groq from "groq-sdk";
import { z } from "zod";
import type {
  InterviewType,
  InterviewLevel,
  InterviewTier,
  InterviewPlan,
  DimensionScore,
  InterviewReport,
  HireSignal,
  StarScore,
  CompetencyPlan,
  DomainPlan,
  ImprovementItem,
  TranscriptEvidence,
} from "@interview/shared-types";
import { calcHireSignal } from "@interview/state-machines";
import pino from "pino";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// ============================================================
// PINO LOGGER
// ============================================================

const LOG_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../logs"
);

fs.mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = path.join(LOG_DIR, "ai-engine.log");

const destination = pino.destination({
  dest: LOG_FILE,
  append: true,
  sync: true,
});

const logger = pino(
  {
    level: "debug",
    base: { service: "ai-engine" },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  destination,
);

const isDev = process.env.NODE_ENV !== "production";

// ============================================================
// GROQ CLIENT — lazy singleton
// ============================================================

let _groq: Groq | null = null;

function getGroq(): Groq {
  if (!_groq) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is not set");
    _groq = new Groq({ apiKey });
  }
  return _groq;
}

const MODELS = {
  planner:     "llama-3.3-70b-versatile",
  interviewer: "llama-3.3-70b-versatile",
  evaluator:   "llama-3.3-70b-versatile",
  scorer:      "llama-3.3-70b-versatile",
  classifier:  "llama-3.1-8b-instant",
} as const;

type ModelRole = keyof typeof MODELS;

// ============================================================
// MESSAGE TYPES
// ============================================================

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ============================================================
// SHARED LOG FUNCTION
// ============================================================

export async function logAITransaction(params: {
  role: ModelRole;
  systemPrompt: string;
  messages: ChatMessage[];
  response: string;
  thinking?: string;
  provider: "groq" | "ollama";
  model: string;
  other?: unknown;
}): Promise<void> {
  const { role, systemPrompt, messages, response, thinking, provider, model, other } = params;

  logger.debug(
    { provider, model, role, systemPrompt, messages, ...(thinking ? { thinking } : {}), response, ...(other ? { other } : {}) },
    "ai-transaction"
  );

  if (isDev) {
    console.log(`[ai-engine] ${provider}/${model} role=${role} response_len=${response.length}`);
  }
}

// ============================================================
// THINKING BLOCK PARSER
// ============================================================

function parseThinkingAndResponse(content: string): { thinking: string; response: string } {
  const match = content.match(/^<think>([\s\S]*?)<\/think>([\s\S]*)$/);
  if (match) {
    return { thinking: (match[1] ?? "").trim(), response: (match[2] ?? "").trim() };
  }
  return { thinking: "", response: content };
}

// ============================================================
// BASE AI CALL
// ============================================================

export async function callAI(
  role: ModelRole,
  systemPrompt: string,
  messages: ChatMessage[],
  maxTokens = 2048
): Promise<string> {
  const groq  = getGroq();
  const model = MODELS[role];

  const completion = await groq.chat.completions.create({
    model,
    max_tokens: maxTokens,
    temperature: 0.7,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  if (!raw) throw new Error("Groq returned empty response");

  const { thinking, response } = parseThinkingAndResponse(raw);

  await logAITransaction({
    provider: "groq",
    model,
    role,
    systemPrompt,
    messages,
    response: thinking ? response : raw,
    ...(thinking ? { thinking } : {}),
    other: completion,
  });

  return thinking ? response : raw;
}

// ============================================================
// RETRY WRAPPER
// ============================================================

async function callAIWithRetry(
  role: ModelRole,
  systemPrompt: string,
  messages: ChatMessage[],
  maxTokens = 2048,
  maxRetries = 3
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await callAI(role, systemPrompt, messages, maxTokens);
    } catch (err: unknown) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) throw err;
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}

async function callAIStreaming(
  role: ModelRole,
  systemPrompt: string,
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
  maxTokens = 2048
): Promise<string> {
  const groq = getGroq();
  let fullText = "";

  const stream = await groq.chat.completions.create({
    model: MODELS[role],
    max_tokens: maxTokens,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    temperature: 0.7,
    stream: true,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      fullText += delta;
      onChunk(delta);
    }
  }

  return fullText;
}

// ============================================================
// JSON EXTRACTION
// ============================================================

function extractJson<T>(text: string, schema: z.ZodType<T>): T {
  const cleaned    = text.replace(/```(?:json)?\n?/g, "").trim();
  const startBrace  = cleaned.indexOf("{");
  const startBracket = cleaned.indexOf("[");
  const start =
    startBrace === -1 ? startBracket
    : startBracket === -1 ? startBrace
    : Math.min(startBrace, startBracket);

  const endBrace   = cleaned.lastIndexOf("}");
  const endBracket = cleaned.lastIndexOf("]");
  const end        = Math.max(endBrace, endBracket);

  if (start === -1 || end === -1) throw new Error(`No JSON found in AI response: ${text.slice(0, 300)}`);

  const jsonStr = cleaned.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`JSON parse error: ${String(e)}\nRaw: ${jsonStr.slice(0, 200)}`);
  }

  return schema.parse(parsed);
}

// ============================================================
// PLAN GENERATION
// ============================================================

const rubricDimensionSchema = z.object({
  name:             z.string(),
  weight:           z.number().min(0).max(1),
  description:      z.string(),
  scoreDescriptors: z.object({ "0": z.string(), "0.5": z.string(), "1": z.string() }),
});

const plannedQuestionSchema = z.object({
  id:                 z.string(),
  phase:              z.number().int(),
  content:            z.string(),
  rubric:             z.array(rubricDimensionSchema).min(1),
  probes:             z.array(z.string()).min(1),
  tradeoffs:          z.array(z.string()).optional(),
  estimationTargets:  z.array(z.string()).optional(),
  followUps:          z.array(z.string()).optional(),
  expectedScope:      z.string().optional(),
  starLRequired:      z.boolean().optional(),
});

const interviewPlanSchema = z.object({
  type:      z.enum(["system_design", "behavioral", "domain_knowledge"]),
  questions: z.array(plannedQuestionSchema).min(1),
});

export async function generateSystemDesignPlan(
  role: string,
  level: InterviewLevel,
  tier: InterviewTier,
  jdText: string | null,
  resumeText: string | null
): Promise<InterviewPlan> {
  const systemPrompt = `You are an expert technical interviewer specializing in system design.
Generate a high-quality interview plan for a ${level}-level ${role} position.
Interview bar: ${tier} (T1=FAANG-level, T2=standard, T3=early-stage).

Rules:
- ONE primary question appropriate for the role and level
- Rubric must have exactly 4 dimensions: requirement_clarification, estimation_accuracy, component_coverage, tradeoff_depth
- Weights must sum to 1.0
- Include 3-5 probes, 2-3 tradeoffs, 2-3 estimationTargets
- RESPOND ONLY WITH VALID JSON. NO PREAMBLE. NO EXPLANATION.`;

  const userMessage = `Role: ${role}
Level: ${level} | Tier: ${tier}
JD: ${jdText ?? "Not provided"}
Resume: ${resumeText ?? "Not provided"}

Return this exact JSON structure:
{
  "type": "system_design",
  "questions": [{
    "id": "q1",
    "phase": 0,
    "content": "<the interview question>",
    "rubric": [
      {"name": "requirement_clarification", "weight": 0.25, "description": "...", "scoreDescriptors": {"0": "...", "0.5": "...", "1": "..."}},
      {"name": "estimation_accuracy", "weight": 0.25, "description": "...", "scoreDescriptors": {"0": "...", "0.5": "...", "1": "..."}},
      {"name": "component_coverage", "weight": 0.25, "description": "...", "scoreDescriptors": {"0": "...", "0.5": "...", "1": "..."}},
      {"name": "tradeoff_depth", "weight": 0.25, "description": "...", "scoreDescriptors": {"0": "...", "0.5": "...", "1": "..."}}
    ],
    "probes": ["...", "..."],
    "tradeoffs": ["...", "..."],
    "estimationTargets": ["...", "..."]
  }]
}`;

  const text = await callAIWithRetry("planner", systemPrompt, [{ role: "user", content: userMessage }]);
  return extractJson(text, interviewPlanSchema) as InterviewPlan;
}

const competencyPlanSchema = z.array(
  z.object({
    competency:    z.string(),
    question:      z.string(),
    expectedScope: z.string(),
    starLRequired: z.boolean(),
    followUps:     z.array(z.string()),
  })
).min(1).max(3);

export async function generateBehavioralPlan(
  role: string,
  level: InterviewLevel,
  jdText: string | null,
  resumeText: string | null
): Promise<CompetencyPlan[]> {
  const systemPrompt = `You are an expert behavioral interviewer.
Generate exactly 3 competency probes: (1) primary gap, (2) adversity/failure, (3) scope & influence.
Level: ${level}. Sparse resume → default to mid-level plan with clarifying opener.
RESPOND ONLY WITH VALID JSON. NO PREAMBLE.`;

  const userMessage = `Role: ${role}
Level: ${level}
JD: ${jdText ?? "Not provided"}
Resume: ${resumeText ?? "Not provided"}

Return JSON array of exactly 3 competencies:
[
  {"competency": "...", "question": "...", "expectedScope": "...", "starLRequired": false, "followUps": ["..."]},
  {"competency": "...", "question": "...", "expectedScope": "...", "starLRequired": false, "followUps": ["..."]},
  {"competency": "...", "question": "...", "expectedScope": "...", "starLRequired": true, "followUps": ["..."]}
]`;

  const text = await callAIWithRetry("planner", systemPrompt, [{ role: "user", content: userMessage }]);
  return extractJson(text, competencyPlanSchema);
}

const domainPlanSchema = z.array(
  z.object({
    domain:               z.string(),
    resumeEvidenceLevel:  z.enum(["weak", "medium", "strong"]),
    jdWeight:             z.number().min(0).max(1),
    questions:            z.object({
      conceptual: z.string(),
      applied:    z.string(),
      edgeCase:   z.string(),
    }),
  })
).min(1).max(3);

export async function generateDomainPlan(
  role: string,
  level: InterviewLevel,
  jdText: string | null,
  resumeText: string | null
): Promise<DomainPlan[]> {
  const systemPrompt = `You are a senior technical interviewer specializing in domain knowledge assessment.
Extract exactly 3 technical domains and create targeted questions for each.
Level: ${level}. Sparse resume → JD-only plan, all claims marked unverified (resumeEvidenceLevel: "weak").
RESPOND ONLY WITH VALID JSON. NO PREAMBLE.`;

  const userMessage = `Role: ${role}
Level: ${level}
JD: ${jdText ?? "Not provided"}
Resume: ${resumeText ?? "Not provided"}

Return JSON array of exactly 3 domains:
[
  {
    "domain": "...",
    "resumeEvidenceLevel": "weak"|"medium"|"strong",
    "jdWeight": 0.0-1.0,
    "questions": {
      "conceptual": "...",
      "applied": "...",
      "edgeCase": "..."
    }
  }
]`;

  const text = await callAIWithRetry("planner", systemPrompt, [{ role: "user", content: userMessage }]);
  return extractJson(text, domainPlanSchema);
}

// ============================================================
// EVALUATION SIGNALS — passed from session controller to interviewer
//
// This is the core fix: the interviewer LLM now receives all scored
// signals so it can adapt question depth, tone, and direction based
// on what the candidate actually demonstrated, not just the plan text.
// ============================================================

export interface EvaluationSignals {
  // ── Conceptual / Phase 1 ────────────────────────────────────
  conceptualScore?: number | null;
  misconceptionsDetected?: string[];
  overconfidenceFlag?: boolean;
  underconfidenceFlag?: boolean;

  // ── Applied / Phase 2 ───────────────────────────────────────
  productionDepthScore?: number | null;
  inflationFlag?: boolean;          // tutorial language masquerading as prod experience

  // ── Depth / Phase 3 ─────────────────────────────────────────
  depthScore?: number | null;
  idkHandled?: boolean;             // candidate gracefully said "I don't know"
  adjacentDomainTested?: boolean;

  // ── Domain 2 / Phase 4 ──────────────────────────────────────
  crossDomainLinked?: boolean;
  d2ExchangeCount?: number;

  // ── Stretch / Phase 5 ───────────────────────────────────────
  firstPrinciplesScore?: number | null;
  learningApproachScore?: number | null;

  // ── Coachability / Phase 6 ──────────────────────────────────
  coachabilityScore?: number | null;

  // ── Overall ─────────────────────────────────────────────────
  overallScore?: number | null;
  dimensionScores?: Array<{ dimension: string; score: number; evidence: string }>;

  // ── Behavioral-specific ─────────────────────────────────────
  storyExistenceConfirmed?: boolean;
  starComponents?: {
    situation?: number;
    task?: number;
    action?: number;
    result?: number;
    learning?: number;
  };
  attributionRatio?: number;        // i/(i+we) ratio — low = credit-sharing risk
  adversityScore?: {
    accountability?: number;
    recoveryArc?: number;
    noBlame?: boolean;
    learningQuality?: number;
  };

  // ── System design-specific ───────────────────────────────────
  coverageScore?: number | null;
  estimationScore?: number | null;
  tradeoffScore?: number | null;
  probeResponseType?: "acknowledged_explained" | "partial" | "defensive";

  // ── Meta ────────────────────────────────────────────────────
  totalExchanges?: number;
  probeCount?: number;
  redirectCount?: number;
  silenceEvents?: number;
  currentDomain?: number;
  totalDomains?: number;
  currentCompetencyIndex?: number;
  totalCompetencies?: number;
}

// ============================================================
// INTERVIEWER CONTEXT — extended with evaluation signals
// ============================================================

export interface InterviewerContext {
  interviewType:     InterviewType;
  role:              string;
  level:             InterviewLevel;
  currentPhase:      number;
  currentState:      string;
  transcript:        Array<{ role: "interviewer" | "candidate"; content: string }>;
  planContext:       string;
  activeProbeIndex:  number;
  followUpIntensity: "hard" | "medium" | "scaffolded";

  /**
   * Live evaluation signals from the XState context.
   * The session controller populates this from the machine's per-phase
   * slices before calling generateInterviewerResponse so the LLM has
   * full signal to adapt question depth and tone.
   */
  evaluationSignals?: EvaluationSignals;
}

// ============================================================
// SIGNAL → DIRECTIVE BUILDER
//
// Converts raw numeric/boolean signals into concrete interviewer
// instructions.  This keeps the system prompt readable and makes the
// adaptation logic testable in isolation.
// ============================================================

function buildAdaptiveDirectives(
  signals: EvaluationSignals,
  interviewType: InterviewType,
  phase: number,
  state: string
): string {
  const directives: string[] = [];
  const stateUpper = state.toUpperCase();

  // ── Misconception handling ────────────────────────────────────────────────
  if (signals.misconceptionsDetected && signals.misconceptionsDetected.length > 0) {
    const list = signals.misconceptionsDetected.map((m) => `  • ${m}`).join("\n");
    directives.push(
      `MISCONCEPTIONS DETECTED — do not correct them directly yet, but shape your next question to expose whether the candidate holds these wrong beliefs:\n${list}`
    );
  }

  // ── Confidence calibration ────────────────────────────────────────────────
  if (signals.overconfidenceFlag) {
    directives.push(
      "OVERCONFIDENCE FLAG — candidate used absolutist language ('always works', 'never fails', 'obviously'). " +
      "Introduce a counterexample or edge case that directly challenges their certainty. " +
      "Do not soften — a T1 interviewer would push back without apology."
    );
  }

  if (signals.underconfidenceFlag) {
    directives.push(
      "UNDERCONFIDENCE FLAG — candidate is hedging excessively. " +
      "Explicitly encourage them to commit to a position: 'Take your best guess — I want to hear your reasoning, not a perfect answer.'"
    );
  }

  // ── Production depth vs tutorial inflation ────────────────────────────────
  if (signals.inflationFlag) {
    directives.push(
      "INFLATION FLAG — candidate used tutorial/textbook language without real production evidence. " +
      "Demand specifics: 'Tell me about a time you actually debugged this in production. What was the incident, what broke, and how did you find it?' " +
      "Do not accept theoretical answers."
    );
  } else if (signals.productionDepthScore !== undefined && signals.productionDepthScore !== null) {
    if (signals.productionDepthScore < 0.3) {
      directives.push(
        `LOW PRODUCTION DEPTH (score: ${signals.productionDepthScore.toFixed(2)}) — candidate has not demonstrated real-world exposure. ` +
        "Ask for a specific incident, outage, or debugging story. Press for concrete tools, timelines, and outcomes."
      );
    } else if (signals.productionDepthScore > 0.7) {
      directives.push(
        `HIGH PRODUCTION DEPTH (score: ${signals.productionDepthScore.toFixed(2)}) — candidate has demonstrated strong real-world experience. ` +
        "Move to more advanced territory: probe failure modes, trade-off decisions made under pressure, or cross-team dependencies."
      );
    }
  }

  // ── Conceptual scoring ────────────────────────────────────────────────────
  if (signals.conceptualScore !== undefined && signals.conceptualScore !== null) {
    if (signals.conceptualScore < 0.4) {
      directives.push(
        `WEAK CONCEPTUAL FOUNDATION (score: ${signals.conceptualScore.toFixed(2)}) — ` +
        "candidate's mental model has significant gaps. Reframe the question at a more fundamental level. " +
        "Ask them to explain the concept from first principles before applying it."
      );
    } else if (signals.conceptualScore > 0.75) {
      directives.push(
        `STRONG CONCEPTUAL FOUNDATION (score: ${signals.conceptualScore.toFixed(2)}) — ` +
        "candidate demonstrated solid understanding. Accelerate to application and edge cases. " +
        "Do not re-explain basics — they've earned the harder questions."
      );
    }
  }

  // ── STAR component gaps (behavioral) ─────────────────────────────────────
  if (interviewType === "behavioral" && signals.starComponents) {
    const star = signals.starComponents;
    const weakComponents: string[] = [];
    if ((star.situation ?? 1) < 0.4) weakComponents.push("Situation (no context given)");
    if ((star.task ?? 1) < 0.4)      weakComponents.push("Task (their specific role unclear)");
    if ((star.action ?? 1) < 0.4)    weakComponents.push("Action (what they personally did)");
    if ((star.result ?? 1) < 0.4)    weakComponents.push("Result (no outcome quantified)");

    if (weakComponents.length > 0) {
      directives.push(
        `INCOMPLETE STAR RESPONSE — these components are missing or thin: ${weakComponents.join(", ")}. ` +
        "Probe the weakest one first. For missing Result: 'What was the measurable outcome? How did you know it worked?' " +
        "For missing Action: 'What did YOU specifically do — not the team, you personally?'"
      );
    }
  }

  // ── Attribution ratio (behavioral) ───────────────────────────────────────
  if (
    interviewType === "behavioral" &&
    signals.attributionRatio !== undefined &&
    signals.attributionRatio < 0.3 &&
    (signals.totalExchanges ?? 0) > 1
  ) {
    directives.push(
      `LOW ATTRIBUTION RATIO (I:We = ${(signals.attributionRatio * 100).toFixed(0)}% I-statements) — ` +
      "candidate is consistently saying 'we' instead of 'I'. " +
      "Challenge them: 'I want to understand your personal contribution specifically. What did you decide? What did you build?'"
    );
  }

  // ── Depth score ───────────────────────────────────────────────────────────
  if (signals.depthScore !== undefined && signals.depthScore !== null) {
    if (signals.depthScore < 0.35) {
      directives.push(
        `SHALLOW DEPTH SCORE (${signals.depthScore.toFixed(2)}) — ` +
        "candidate's answers are staying at a surface level. " +
        "Ask 'Why?' and 'What would break this?' repeatedly until they hit a wall or demonstrate real depth."
      );
    }
  }

  // ── Coachability signal ───────────────────────────────────────────────────
  if (signals.coachabilityScore !== undefined && signals.coachabilityScore !== null) {
    if (signals.coachabilityScore < 0.4) {
      directives.push(
        `LOW COACHABILITY (score: ${signals.coachabilityScore.toFixed(2)}) — ` +
        "candidate became defensive or ignored the challenge. " +
        "Acknowledge their position but restate the challenge more directly: " +
        "'I hear you, but I'm specifically asking about the case where [restate challenge]. What would you do then?'"
      );
    } else if (signals.coachabilityScore > 0.8) {
      directives.push(
        `HIGH COACHABILITY — candidate engaged thoughtfully with pushback. ` +
        "Issue a stronger challenge on a different assumption to stress-test intellectual confidence."
      );
    }
  }

  // ── Probe count management ────────────────────────────────────────────────
  if (signals.probeCount !== undefined && signals.probeCount >= 3) {
    directives.push(
      `PROBE DEPTH: ${signals.probeCount} probes issued so far. ` +
      "If the candidate has still not demonstrated satisfactory depth after this probe, " +
      "accept their answer and move to the next topic rather than continuing to press on the same point."
    );
  }

  // ── IDK handling ──────────────────────────────────────────────────────────
  if (signals.idkHandled) {
    directives.push(
      "CANDIDATE USED 'I DON'T KNOW' GRACEFULLY — this is a positive signal. " +
      "Acknowledge it briefly and pivot to a related area where they may have more exposure: " +
      "'That's fine — let's approach it from a different angle.'"
    );
  }

  // ── Cross-domain linking ──────────────────────────────────────────────────
  if (signals.crossDomainLinked) {
    directives.push(
      "CROSS-DOMAIN LINK ESTABLISHED — candidate connected concepts across domains. " +
      "Reward this by going deeper: 'Interesting connection — push that further. How does that relationship hold under load?'"
    );
  }

  // ── System design: coverage gaps ──────────────────────────────────────────
  if (interviewType === "system_design") {
    if (signals.coverageScore !== undefined && signals.coverageScore !== null && signals.coverageScore < 0.4) {
      directives.push(
        `LOW COMPONENT COVERAGE (score: ${signals.coverageScore.toFixed(2)}) — ` +
        "candidate has missed major system components. " +
        "Redirect: 'You've covered [what they did]. What about [missing component]? How does that fit in?'"
      );
    }
    if (signals.tradeoffScore !== undefined && signals.tradeoffScore !== null && signals.tradeoffScore < 0.3) {
      directives.push(
        `WEAK TRADEOFF REASONING (score: ${signals.tradeoffScore.toFixed(2)}) — ` +
        "candidate is not articulating why they chose one approach over alternatives. " +
        "Force the comparison: 'Why not [alternative approach]? Walk me through that decision.'"
      );
    }
    if (signals.probeResponseType === "defensive") {
      directives.push(
        "DEFENSIVE PROBE RESPONSE — candidate pushed back on your challenge without justification. " +
        "Stay firm: 'I understand you prefer that approach, but I want to understand how it handles [the specific failure mode].'"
      );
    }
  }

  // ── State-specific directives ─────────────────────────────────────────────
  if (stateUpper.includes("SILENCE") || stateUpper.includes("NUDGE")) {
    // Override all other directives — silence states need a specific response
    return "SILENCE NUDGE — candidate has gone quiet. Say ONLY: 'Take your time — feel free to think aloud.' Nothing else.";
  }

  if (stateUpper.includes("REDIRECT")) {
    directives.push(
      "REDIRECT STATE — candidate drifted off-topic. " +
      "Bring them back without being abrupt: 'That's useful context — let's bring it back to [original topic]. Specifically, [rephrase the original question].'"
    );
  }

  if (stateUpper.includes("CANDIDATE_QA") || stateUpper.includes("WRAP") || stateUpper.includes("CLOS")) {
    return "CLOSING STATE — invite the candidate to ask questions: 'We're wrapping up. Do you have any questions about the role, the team, or the process?'";
  }

  return directives.length > 0
    ? "ADAPTIVE DIRECTIVES (apply these based on candidate performance):\n" + directives.join("\n\n")
    : "No specific adaptive directives — follow the plan naturally.";
}

// ============================================================
// PHASE-AWARE QUESTION GUIDANCE BUILDER
//
// Tells the interviewer LLM which question type to ask based on the
// current machine state, rather than leaving it to guess from state
// name strings alone.
// ============================================================

function buildPhaseGuidance(
  interviewType: InterviewType,
  state: string,
  phase: number,
  planContext: string,
  signals: EvaluationSignals
): string {
  const stateUpper = state.toUpperCase();
  const lines: string[] = [];

  // ── Domain knowledge phase guidance ──────────────────────────────────────
  if (interviewType === "domain_knowledge") {
    const domainIdx  = signals.currentDomain ?? 0;
    const totalDomns = signals.totalDomains ?? 3;

    if (stateUpper === "CONCEPTUAL_QUESTION") {
      lines.push(
        `PHASE 1 — CONCEPTUAL FOUNDATION (Domain ${domainIdx + 1}/${totalDomns})`,
        "Ask the conceptual question from your plan. This is a baseline — do not hint at the answer.",
        "Goal: Establish the candidate's mental model before probing applied experience."
      );
    } else if (stateUpper === "APPLIED_QUESTION") {
      lines.push(
        `PHASE 2 — APPLIED EXPERIENCE (Domain ${domainIdx + 1}/${totalDomns})`,
        "Ask the applied question from your plan. You are now testing whether they have production exposure.",
        "Goal: Distinguish real experience from textbook knowledge."
      );
    } else if (stateUpper === "WAR_STORY_PROBE") {
      lines.push(
        "WAR STORY PROBE — ask for a specific production story.",
        "Prompt: 'Tell me about a time you dealt with this in a real system. What went wrong and how did you fix it?'",
        "Do not accept 'I would...' answers. Redirect to 'Tell me about a time you actually did...'"
      );
    } else if (stateUpper === "EDGE_CASE_QUESTION") {
      lines.push(
        `PHASE 3 — EDGE CASES & LIMITS (Domain ${domainIdx + 1}/${totalDomns})`,
        "Ask the edge case question from your plan.",
        "Goal: Find the boundaries of their knowledge. Good engineers know what breaks their systems."
      );
    } else if (stateUpper === "D2_FLOWING_CONVO") {
      lines.push(
        `PHASE 4 — DOMAIN 2 CONVERSATIONAL PROBE (Exchange ${(signals.d2ExchangeCount ?? 0) + 1})`,
        "This is a more fluid domain — probe breadth and cross-domain thinking.",
        "Keep questions shorter. React to what they say. Build on their answers.",
        `D2 exchanges so far: ${signals.d2ExchangeCount ?? 0}. ` +
        "If they're showing depth, push deeper. If they're struggling, pivot to a related area."
      );
    } else if (stateUpper === "STRETCH_FRAMING") {
      lines.push(
        "PHASE 5 — STRETCH PROBE (0.5× weight — this tests intellectual range, not correctness)",
        "Frame the stretch domain clearly: 'Now I want to shift to something you may not have direct experience with.'",
        "This is intentionally harder. You are testing how they think when they don't know the answer."
      );
    } else if (stateUpper === "FIRST_PRINCIPLES_TEST") {
      lines.push(
        "FIRST PRINCIPLES TEST — do not accept 'I've never used that technology' as a complete answer.",
        "Push: 'Based on what you know about [related concepts], how would you reason through this?'",
        "You are scoring intellectual approach, not domain knowledge."
      );
    } else if (stateUpper === "DELIBERATE_CHALLENGE") {
      lines.push(
        "PHASE 6 — DELIBERATE CHALLENGE (coachability test)",
        "Issue a statement that is intentionally wrong or partially wrong.",
        "Example: 'Actually, I'd argue [incorrect claim about their domain]. Do you agree?'",
        "Do NOT signal that this is a test. Deliver it confidently as a genuine position.",
        "You are scoring: do they push back with evidence, capitulate, or deflect?"
      );
    }
  }

  // ── Behavioral phase guidance ──────────────────────────────────────────────
  if (interviewType === "behavioral") {
    const compIdx   = signals.currentCompetencyIndex ?? 0;
    const totalComp = signals.totalCompetencies ?? 3;

    if (stateUpper === "BASELINE_QUESTION") {
      lines.push(
        `BEHAVIORAL BASELINE (Competency ${compIdx + 1}/${totalComp})`,
        "Ask the opening competency question from your plan.",
        "Goal: Get the candidate talking. Assess communication structure before probing."
      );
    } else if (stateUpper === "CONTEXT_SETTING") {
      lines.push(
        "CONTEXT SETTING — help the candidate orient before their story.",
        "If they seem lost: 'Take me back to a specific situation. Set the scene for me — where were you, what was the project, what was your role?'"
      );
    } else if (stateUpper === "DELIVERING_Q1" || stateUpper.startsWith("DELIVERING")) {
      lines.push(
        `COMPETENCY QUESTION (${compIdx + 1}/${totalComp}) — ask from your plan.`,
        "Use STAR framing implicitly. Do NOT say 'Tell me the Situation, Task, Action, Result.'",
        "Just ask the question naturally and let their structure reveal itself."
      );
    } else if (stateUpper === "RESULT_DEPTH_PROBE_1") {
      lines.push(
        "RESULT DEPTH PROBE — candidate's result was thin. Probe for quantification.",
        "'What was the actual impact? How did you measure it? What changed after you did this?'",
        "Accept numbers, percentages, timelines, or concrete qualitative outcomes."
      );
    } else if (stateUpper === "ADVERSITY_QUESTION") {
      lines.push(
        "ADVERSITY PROBE — move to the failure/setback competency.",
        "Ask from your plan. Frame it as a genuine interest in learning experience.",
        "Goal: See if they own failures or deflect blame."
      );
    } else if (stateUpper === "ACCOUNTABILITY_PROBE") {
      lines.push(
        "ACCOUNTABILITY PROBE — candidate's adversity answer lacked personal ownership.",
        "'In that situation, looking back, what's one thing you personally could have done differently?'",
        "You are testing whether they can reflect critically on their own role."
      );
    } else if (stateUpper === "INFLUENCE_QUESTION") {
      lines.push(
        "SCOPE & INFLUENCE PROBE — test organizational reach.",
        "Ask from your plan. You are looking for: stakeholder management, cross-functional work, and leadership without authority."
      );
    } else if (stateUpper === "STAKEHOLDER_PROBE") {
      lines.push(
        "STAKEHOLDER PROBE — dig into how they navigated disagreement.",
        "'Who pushed back on you? How did you bring them around?'",
        "Generic answers about 'alignment' are not enough — press for the specific difficult person or meeting."
      );
    }
  }

  // ── System design phase guidance ──────────────────────────────────────────
  if (interviewType === "system_design") {
    if (stateUpper === "DELIVERING" || stateUpper === "SILENCE_WATCH") {
      lines.push(
        "SYSTEM DESIGN — candidate is working through their design.",
        "Do not interrupt unless they've been silent for a while or are going off-track.",
        "If they ask a clarifying question, answer it briefly and concisely."
      );
    } else if (stateUpper === "CLARIFYING") {
      lines.push(
        "CLARIFICATION PHASE — candidate is asking requirements questions.",
        "Answer their questions concisely. Volunteer no extra information.",
        "If they've been clarifying for >3 exchanges, nudge: 'Good questions. What assumptions are you making and let's move to the design?'"
      );
    } else if (stateUpper === "PROBE_ISSUE") {
      lines.push(
        "PROBE ISSUE — issue a targeted probe about a specific gap in their design.",
        "Reference what they actually said: 'You mentioned [specific component]. Walk me through how that handles [failure mode/scale/edge case].'",
        "Do not probe multiple things at once. One focused probe."
      );
    } else if (stateUpper === "TRADEOFF_CHALLENGE") {
      lines.push(
        "TRADEOFF CHALLENGE — challenge their architectural decision.",
        "'Why [their choice] over [alternative]? Walk me through that trade-off.'",
        "Push back on hand-wavy answers. A good engineer can justify their decisions under pressure."
      );
    } else if (stateUpper === "FAILURE_MODE_PROBE") {
      lines.push(
        "FAILURE MODE PROBE — push on system resilience.",
        "'What happens when [component] fails? How does the system degrade gracefully?'",
        "You are looking for: retry logic, circuit breakers, data consistency under failure, graceful degradation."
      );
    } else if (stateUpper === "SCALE_STRESS_TEST") {
      lines.push(
        "SCALE STRESS TEST — push the design to its limits.",
        "'Your design works at 1M users. What breaks first at 100M?'",
        "Good answer: identifies specific bottlenecks and mitigation. Bad answer: 'just add more servers.'"
      );
    } else if (stateUpper === "SELF_CRITIQUE_PROMPT") {
      lines.push(
        "SELF-CRITIQUE PROMPT — invite the candidate to critique their own design.",
        "'If you had to redesign one part of this from scratch, what would it be and why?'",
        "This tests self-awareness. Strong candidates identify real weaknesses; weak ones say 'I'd keep it the same.'"
      );
    }
  }

  if (lines.length === 0) return planContext;

  return [planContext, "", "PHASE GUIDANCE:", ...lines].join("\n");
}

// ============================================================
// INTERVIEWER — generates next question / probe / nudge
// ============================================================

export async function generateInterviewerResponse(
  ctx: InterviewerContext,
  onChunk?: (chunk: string) => void
): Promise<string> {

  const signals    = ctx.evaluationSignals ?? {};
  const stateUpper = ctx.currentState.toUpperCase();

  // ── Fast-path: silence nudge states ──────────────────────────────────────
  // These states need a single fixed response — don't waste a full LLM call.
  if (stateUpper.includes("SILENCE_NUDGE") || stateUpper === "SILENCE_NUDGE_ISSUED") {
    return "Take your time — feel free to think aloud.";
  }

  // ── Build adaptive directive block ────────────────────────────────────────
  const adaptiveDirectives = buildAdaptiveDirectives(
    signals, ctx.interviewType, ctx.currentPhase, ctx.currentState
  );

  // ── Build phase-aware question guidance ───────────────────────────────────
  const phaseGuidance = buildPhaseGuidance(
    ctx.interviewType, ctx.currentState, ctx.currentPhase, ctx.planContext, signals
  );

  // ── Determine follow-up intensity label ───────────────────────────────────
  // Derive dynamically from signals rather than trusting the passed value,
  // which is frequently left at the default "medium".
  let effectiveIntensity = ctx.followUpIntensity;

  if (signals.conceptualScore !== undefined && signals.conceptualScore !== null) {
    if      (signals.conceptualScore < 0.35) effectiveIntensity = "scaffolded";
    else if (signals.conceptualScore > 0.75) effectiveIntensity = "hard";
  }
  if (signals.overconfidenceFlag)            effectiveIntensity = "hard";
  if (signals.underconfidenceFlag)           effectiveIntensity = "scaffolded";
  if (signals.inflationFlag)                 effectiveIntensity = "hard";

  // ── Candidate last answer (for reference) ────────────────────────────────
  const lastCandidate = [...ctx.transcript]
    .reverse()
    .find((m) => m.role === "candidate");
  const lastCandidateExcerpt = lastCandidate
    ? `\nCANDIDATE'S LAST ANSWER (excerpt):\n"${lastCandidate.content.slice(0, 400)}${lastCandidate.content.length > 400 ? "..." : ""}"`
    : "";

  // ── System prompt ─────────────────────────────────────────────────────────
  const systemPrompt = `You are a senior ${ctx.interviewType.replace(/_/g, " ")} interviewer conducting a real interview.
Candidate profile: ${ctx.level}-level ${ctx.role}.
Current phase: ${ctx.currentPhase} | Machine state: ${ctx.currentState}
Interview bar: follow-up intensity is "${effectiveIntensity}".

${phaseGuidance}

CORE INTERVIEWER RULES (non-negotiable):
1. Ask ONE question or issue ONE probe at a time. Never stack multiple questions.
2. Reference the candidate's actual words when probing — not generic follow-ups.
3. Do NOT open with affirmations. Never say "Great", "Excellent", "Impressive", "That's right", "Good answer".
   Say "Got it.", "Okay.", "I see.", or nothing — then move directly to your question.
4. Be concise. Real interviewers do not give speeches. Target 1-3 sentences.
5. Stay in character. You are a real interviewer. Never break the simulation.
6. If the candidate asked a question, answer it directly and briefly, then move on.
7. Vary your phrasing — do not repeat the same sentence structure across turns.

INTENSITY GUIDE:
- "hard": Challenge every claim, demand specifics, push back on weak justifications. No softening.
- "medium": Probe naturally, follow threads that seem thin, move forward when satisfied.
- "scaffolded": Help them structure their thinking. Break questions into smaller pieces. Reduce pressure.

${adaptiveDirectives}
${lastCandidateExcerpt}

Your response must be ONLY your interviewer message — no meta-commentary, no labels, no preamble.`;

  // ── Build message history ─────────────────────────────────────────────────
  const messages: ChatMessage[] = ctx.transcript.map((m) => ({
    role:    m.role === "interviewer" ? "assistant" : "user",
    content: m.content,
  }));

  // Groq requires messages to start with user turn
  if (messages.length === 0 || messages[0]?.role !== "user") {
    messages.unshift({
      role:    "user",
      content: "[Session started. Please ask the opening question based on your plan.]",
    });
  }

  // ── Streaming path ────────────────────────────────────────────────────────
  if (onChunk) {
    try {
      return await callAIStreaming("interviewer", systemPrompt, messages, onChunk);
    } catch (streamErr: unknown) {
      const status = (streamErr as { status?: number }).status;
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) throw streamErr;
      return callAIWithRetry("interviewer", systemPrompt, messages);
    }
  }

  return callAIWithRetry("interviewer", systemPrompt, messages);
}

// ============================================================
// EVALUATOR
// ============================================================

export interface EvalRequest {
  question:  string;
  answer:    string;
  phase:     number;
  stateName: string;
  rubric:    Array<{ name: string; weight: number; description: string }>;
  context:   string;
}

export interface EvalResult {
  signals: Array<{
    dimension: string;
    signal:    string;
    value:     number | boolean | string;
    evidence:  string;
  }>;
  followUpNeeded: boolean;
  suggestedProbe: string | null;
  flags:          string[];
}

const evalResultSchema = z.object({
  signals: z.array(z.object({
    dimension: z.string(),
    signal:    z.string(),
    value:     z.union([z.number(), z.boolean(), z.string()]),
    evidence:  z.string(),
  })),
  followUpNeeded: z.boolean(),
  suggestedProbe: z.string().nullable(),
  flags:          z.array(z.string()),
});

export async function evaluateAnswer(req: EvalRequest): Promise<EvalResult> {
  const systemPrompt = `You are a precise interview evaluator. Score answers against rubric dimensions.
Be evidence-based — cite specific phrases from the answer. RESPOND ONLY WITH VALID JSON.`;

  const userMessage = `Question: ${req.question}
Answer: ${req.answer}
Phase: ${req.phase} | State: ${req.stateName}
Rubric dimensions: ${JSON.stringify(req.rubric)}
Context: ${req.context}

Return JSON:
{
  "signals": [{"dimension": "string", "signal": "string", "value": 0.0, "evidence": "quoted phrase"}],
  "followUpNeeded": false,
  "suggestedProbe": null,
  "flags": []
}`;

  const text = await callAIWithRetry("evaluator", systemPrompt, [{ role: "user", content: userMessage }]);
  return extractJson(text, evalResultSchema);
}

// ============================================================
// SCORING
// ============================================================

const dimensionScoreSchema = z.object({
  dimension:         z.string(),
  score:             z.number().min(0).max(1),
  evidence:          z.string(),
  transcriptIndices: z.array(z.number()),
});

const scoringResultSchema = z.object({
  scores:  z.array(dimensionScoreSchema).min(1),
  overall: z.number().min(0).max(1),
});

export async function computeDimensionScores(
  interviewType: InterviewType,
  transcript:    Array<{ role: string; content: string; phase: number; stateName: string }>,
  plan:          InterviewPlan | CompetencyPlan[] | DomainPlan[],
  tier:          InterviewTier
): Promise<{ scores: DimensionScore[]; overall: number; hireSignal: HireSignal }> {
  const systemPrompt = `You are the final scoring expert for ${interviewType.replace(/_/g, " ")} interviews.
Analyse the full transcript and score each dimension from 0.0 to 1.0.
Tier: ${tier} (T1 = higher bar, scores must be exceptional to qualify).
Be strict and evidence-based. RESPOND ONLY WITH VALID JSON.`;

  const transcriptText = transcript
    .map((m, i) => `[${i}] ${m.role.toUpperCase()} (phase ${m.phase}): ${m.content}`)
    .join("\n");

  const userMessage = `Transcript:\n${transcriptText}\n\nPlan:\n${JSON.stringify(plan, null, 2)}\n\nReturn JSON:
{
  "scores": [{"dimension": "string", "score": 0.0, "evidence": "string", "transcriptIndices": [0]}],
  "overall": 0.0
}`;

  const text   = await callAIWithRetry("scorer", systemPrompt, [{ role: "user", content: userMessage }], 4096);
  const result = extractJson(text, scoringResultSchema);

  return {
    scores:      result.scores as DimensionScore[],
    overall:     result.overall,
    hireSignal:  calcHireSignal(result.overall, tier),
  };
}

// ============================================================
// REPORT GENERATOR
// ============================================================

const reportBodySchema = z.object({
  strengthSummary: z.string(),
  improvementPlan: z.array(z.object({
    area:           z.string(),
    observation:    z.string(),
    recommendation: z.string(),
    priority:       z.enum(["high", "medium", "low"]),
  })).min(1),
  transcriptEvidence: z.array(z.object({
    claim:           z.string(),
    transcriptIndex: z.number().int().min(0),
    quote:           z.string(),
    signal:          z.enum(["positive", "negative", "neutral"]),
  })),
});

export async function generateReport(
  interviewType:   InterviewType,
  sessionId:       string,
  dimensionScores: DimensionScore[],
  overall:         number,
  hireSignal:      HireSignal,
  transcript:      Array<{ role: string; content: string; phase: number }>,
  tier:            InterviewTier
): Promise<InterviewReport> {
  const systemPrompt = `You are the report generation expert for ${interviewType.replace(/_/g, " ")} interviews.
Write a comprehensive, actionable candidate report. Be specific and constructive.
RESPOND ONLY WITH VALID JSON. NO PREAMBLE.`;

  const last30          = transcript.slice(-30);
  const transcriptText  = last30
    .map((m, i) => `[${i}] ${m.role.toUpperCase()} (phase ${m.phase}): ${m.content}`)
    .join("\n");

  const userMessage = `Session: ${sessionId}
Tier: ${tier} | Type: ${interviewType} | Signal: ${hireSignal} | Score: ${overall}
Dimension Scores: ${JSON.stringify(dimensionScores)}
Transcript (last 30):
${transcriptText}

Return JSON:
{
  "strengthSummary": "2-3 sentence summary of key strengths",
  "improvementPlan": [
    {"area": "string", "observation": "string", "recommendation": "string", "priority": "high"}
  ],
  "transcriptEvidence": [
    {"claim": "string", "transcriptIndex": 0, "quote": "short verbatim quote", "signal": "positive"}
  ]
}`;

  const text = await callAIWithRetry("scorer", systemPrompt, [{ role: "user", content: userMessage }], 4096);
  const body = extractJson(text, reportBodySchema);

  return {
    sessionId,
    type:               interviewType,
    hireSignal,
    overallScore:       overall,
    dimensionScores,
    strengthSummary:    body.strengthSummary,
    improvementPlan:    body.improvementPlan as ImprovementItem[],
    transcriptEvidence: body.transcriptEvidence as TranscriptEvidence[],
    generatedAt:        new Date(),
  };
}

// ============================================================
// CLASSIFIERS
// ============================================================

export async function detectFirstMove(candidateResponse: string): Promise<"CLARIFY" | "JUMP"> {
  const lower        = candidateResponse.toLowerCase();
  const clarifyWords = ["clarif", "question", "mean", "scope", "requirement", "assumption", "constraint", "how many", "what kind", "who are"];
  const jumpWords    = ["i would use", "my approach", "the architecture", "load balancer", "microservice", "i'll design", "we need a database", "the system should"];

  const clarifyHits = clarifyWords.filter((w) => lower.includes(w)).length;
  const jumpHits    = jumpWords.filter((w) => lower.includes(w)).length;

  if (clarifyHits > jumpHits && clarifyHits > 0) return "CLARIFY";
  if (jumpHits > clarifyHits && jumpHits > 0)    return "JUMP";

  const systemPrompt = `Classify this system design interview response.
Return ONLY the single word "CLARIFY" or "JUMP".
CLARIFY = candidate is asking clarifying questions or stating assumptions before designing.
JUMP = candidate jumped straight into solution without clarifying requirements.`;

  const text = await callAIWithRetry(
    "classifier",
    systemPrompt,
    [{ role: "user", content: candidateResponse.slice(0, 500) }],
    5
  );

  return text.trim().toUpperCase().includes("CLARIFY") ? "CLARIFY" : "JUMP";
}

export async function detectStoryExistence(answer: string): Promise<boolean> {
  const noStoryPhrases = [
    "can't think", "i don't have", "not sure i have",
    "nothing comes to mind", "i've never", "can't recall",
    "don't remember", "no example", "hard to think",
  ];
  const lower = answer.toLowerCase();
  return !noStoryPhrases.some((p) => lower.includes(p));
}

export async function detectMisconceptions(
  domain: string,
  answer: string,
  _knownFacts: string[]
): Promise<string[]> {
  const systemPrompt = `You are a domain expert in ${domain}.
List any factual misconceptions in the candidate's answer.
Return ONLY a JSON array of strings: ["misconception 1", ...] or [] if none.
Be strict — only flag clear technical errors, not opinions or style choices.`;

  const text = await callAIWithRetry(
    "classifier",
    systemPrompt,
    [{ role: "user", content: answer.slice(0, 1000) }],
    256
  );

  try {
    const cleaned = text.replace(/```(?:json)?\n?/g, "").trim();
    const arr     = JSON.parse(cleaned);
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}

export async function assessConfidence(answer: string): Promise<{ overconfident: boolean; underconfident: boolean }> {
  const lower       = answer.toLowerCase();
  const overMarkers = ["always", "definitely", "never fails", "always works", "obviously", "clearly it's", "without a doubt"];
  const underMarkers = ["i think maybe", "i'm not sure but", "probably", "might be wrong", "not totally sure"];

  return {
    overconfident:  overMarkers.filter((m) => lower.includes(m)).length >= 2,
    underconfident: underMarkers.filter((m) => lower.includes(m)).length >= 2,
  };
}

export async function classifyProductionDepth(answer: string): Promise<{ depth: number; inflation: boolean }> {
  const lower          = answer.toLowerCase();
  const prodSignals    = ["production", "incident", "outage", "debugging", "on-call", "rollback", "migration", "monitoring", "alert", "postmortem", "p0", "p1", "sev"];
  const tutorialSignals = ["tutorial", "course", "documentation says", "i read that", "theoretically", "from what i understand", "i believe it works by"];

  const prodCount = prodSignals.filter((s) => lower.includes(s)).length;
  const tutCount  = tutorialSignals.filter((s) => lower.includes(s)).length;

  return {
    depth:     Math.min(1, prodCount / 3),
    inflation: tutCount > prodCount && prodCount < 2,
  };
}

export async function parseStarComponents(competency: string, answer: string): Promise<Partial<StarScore>> {
  const systemPrompt = `You are a behavioral interview evaluator. Parse STAR components from this answer.
Score each component 0.0-1.0. Missing components score 0.
RESPOND ONLY WITH VALID JSON.`;

  const schema = z.object({
    situation: z.number().min(0).max(1),
    task:      z.number().min(0).max(1),
    action:    z.number().min(0).max(1),
    result:    z.number().min(0).max(1),
    learning:  z.number().min(0).max(1).optional(),
  });

  const text = await callAIWithRetry(
    "evaluator",
    systemPrompt,
    [{ role: "user", content: `Competency: ${competency}\nAnswer: ${answer}\n\nReturn: {"situation":0.0,"task":0.0,"action":0.0,"result":0.0}` }],
    256
  );

  try {
    return extractJson(text, schema);
  } catch {
    return { situation: 0, task: 0, action: 0, result: 0 };
  }
}

export async function detectAttributionFlag(answer: string): Promise<{ hasFlag: boolean; ratio: number }> {
  const words    = answer.toLowerCase().split(/\s+/);
  const iCount   = words.filter((w) => ["i", "i've", "i'd", "i'll", "i'm", "my", "me"].includes(w)).length;
  const weCount  = words.filter((w) => ["we", "we've", "we'd", "we'll", "our", "us", "the team"].includes(w)).length;
  const total    = iCount + weCount;
  const ratio    = total > 0 ? iCount / total : 0.5;

  return {
    hasFlag: ratio < 0.3 && weCount > 4,
    ratio,
  };
}

export async function scoreCoachability(challenge: string, response: string): Promise<number> {
  const systemPrompt = `Score this candidate's response to a deliberate challenge. Return ONLY a decimal number 0.0-1.0.

Scoring guide:
1.0 = Engaged + reasoned + acknowledged nuance (ideal arc)
0.8 = Engaged + reasoned, held position with justification
0.6 = Engaged but capitulated without reasoning
0.4 = Partially engaged, mostly deflected
0.2 = Refused to engage or became defensive
0.0 = Ignored the challenge entirely`;

  const text  = await callAIWithRetry(
    "classifier",
    systemPrompt,
    [{ role: "user", content: `Challenge: ${challenge}\n\nResponse: ${response}` }],
    10
  );
  const score = parseFloat(text.trim().replace(/[^0-9.]/g, ""));
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0.5;
}