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

/**
 * Groq model assignments per "expert" role.
 * llama-3.3-70b-versatile  — best available for complex reasoning
 * llama-3.1-8b-instant      — fast, cheap for simple classification tasks
 */
const MODELS = {
  planner: "llama-3.3-70b-versatile",
  interviewer: "llama-3.3-70b-versatile",
  evaluator: "llama-3.3-70b-versatile",
  scorer: "llama-3.3-70b-versatile",
  classifier: "llama-3.1-8b-instant", // fast path for single-token decisions
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
// BASE AI CALL
// ============================================================

async function callAI(
  role: ModelRole,
  systemPrompt: string,
  messages: ChatMessage[],
  maxTokens = 2048
): Promise<string> {
  const groq = getGroq();

  const response = await groq.chat.completions.create({
    model: MODELS[role],
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages,
    ],
    temperature: 0.7,
  });

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error("Groq returned empty response");
  return text;
}

/**
 * callAIWithRetry — wraps callAI with exponential backoff.
 *
 * Groq rate-limits (429) and transient 5xx errors should not fail an
 * interview. Three retries with 500ms / 1s / 2s backoff cover the
 * vast majority of transient failures without adding noticeable latency
 * on the happy path.
 *
 * Errors that should NOT be retried (e.g. invalid request, auth failure)
 * are re-thrown immediately on the first attempt since they won't recover.
 */
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
      // Don't retry on client-side errors (4xx other than 429)
      const status = (err as { status?: number }).status;
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        throw err;
      }
      if (attempt < maxRetries - 1) {
        const delayMs = 500 * Math.pow(2, attempt); // 500ms, 1s, 2s
        await new Promise((resolve) => setTimeout(resolve, delayMs));
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
    messages: [
      { role: "system", content: systemPrompt },
      ...messages,
    ],
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
// JSON EXTRACTION — robust, strips fences
// ============================================================

function extractJson<T>(text: string, schema: z.ZodType<T>): T {
  // Strip markdown code fences
  const cleaned = text.replace(/```(?:json)?\n?/g, "").trim();

  // Find first { or [ and last } or ]
  const startBrace = cleaned.indexOf("{");
  const startBracket = cleaned.indexOf("[");
  const start =
    startBrace === -1
      ? startBracket
      : startBracket === -1
      ? startBrace
      : Math.min(startBrace, startBracket);

  const endBrace = cleaned.lastIndexOf("}");
  const endBracket = cleaned.lastIndexOf("]");
  const end = Math.max(endBrace, endBracket);

  if (start === -1 || end === -1) {
    throw new Error(`No JSON found in AI response: ${text.slice(0, 300)}`);
  }

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
  name: z.string(),
  weight: z.number().min(0).max(1),
  description: z.string(),
  scoreDescriptors: z.object({
    "0": z.string(),
    "0.5": z.string(),
    "1": z.string(),
  }),
});

const plannedQuestionSchema = z.object({
  id: z.string(),
  phase: z.number().int(),
  content: z.string(),
  rubric: z.array(rubricDimensionSchema).min(1),
  probes: z.array(z.string()).min(1),
  tradeoffs: z.array(z.string()).optional(),
  estimationTargets: z.array(z.string()).optional(),
  followUps: z.array(z.string()).optional(),
  expectedScope: z.string().optional(),
  starLRequired: z.boolean().optional(),
});

const interviewPlanSchema = z.object({
  type: z.enum(["system_design", "behavioral", "domain_knowledge"]),
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

  const text = await callAIWithRetry("planner", systemPrompt, [
    { role: "user", content: userMessage },
  ]);

  return extractJson(text, interviewPlanSchema) as InterviewPlan;
}

const competencyPlanSchema = z.array(
  z.object({
    competency: z.string(),
    question: z.string(),
    expectedScope: z.string(),
    starLRequired: z.boolean(),
    followUps: z.array(z.string()),
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

  const text = await callAIWithRetry("planner", systemPrompt, [
    { role: "user", content: userMessage },
  ]);

  return extractJson(text, competencyPlanSchema);
}

const domainPlanSchema = z.array(
  z.object({
    domain: z.string(),
    resumeEvidenceLevel: z.enum(["weak", "medium", "strong"]),
    jdWeight: z.number().min(0).max(1),
    questions: z.object({
      conceptual: z.string(),
      applied: z.string(),
      edgeCase: z.string(),
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

  const text = await callAIWithRetry("planner", systemPrompt, [
    { role: "user", content: userMessage },
  ]);

  return extractJson(text, domainPlanSchema);
}

// ============================================================
// INTERVIEWER — generates next question / probe / nudge
// ============================================================

export interface InterviewerContext {
  interviewType: InterviewType;
  role: string;
  level: InterviewLevel;
  currentPhase: number;
  currentState: string;
  transcript: Array<{ role: "interviewer" | "candidate"; content: string }>;
  planContext: string;
  activeProbeIndex: number;
  followUpIntensity: "hard" | "medium" | "scaffolded";
}

export async function generateInterviewerResponse(
  ctx: InterviewerContext,
  onChunk?: (chunk: string) => void
): Promise<string> {
  const systemPrompt = `You are an expert ${ctx.interviewType.replace(/_/g, " ")} interviewer.
Candidate: ${ctx.level}-level ${ctx.role}.
Current phase: ${ctx.currentPhase} | State: ${ctx.currentState}
${ctx.planContext}

RULES:
- Ask ONE question at a time — never stack multiple questions
- Reference the candidate's specific words when probing
- Follow-up intensity: ${ctx.followUpIntensity}
- If this is a probe (probe index ${ctx.activeProbeIndex}), dig into the weakest part of their last answer
- If state contains REDIRECT: redirect back to the requirement/topic that was skipped
- If state contains NUDGE or SILENCE: say only "Take your time — feel free to think aloud."
- Stay in character as a real interviewer. Never break the simulation.
- Be concise. Real interviewers don't give speeches.`;

  const messages: ChatMessage[] = ctx.transcript.map((m) => ({
    role: m.role === "interviewer" ? "assistant" : "user",
    content: m.content,
  }));

  // Groq requires messages to start with user turn
  if (messages.length === 0 || messages[0]?.role !== "user") {
    messages.unshift({ role: "user", content: "[Session started. Please ask the first question.]" });
  }

  if (onChunk) {
    // Streaming cannot be transparently retried once chunks have been sent to
    // the client. If streaming fails mid-stream, fall back to the non-streaming
    // path so the client always gets a complete response (via the terminal frame).
    try {
      return await callAIStreaming("interviewer", systemPrompt, messages, onChunk);
    } catch (streamErr: unknown) {
      const status = (streamErr as { status?: number }).status;
      // Only retry on transient errors (429, 5xx). Don't swallow auth failures.
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        throw streamErr;
      }
      // Fall back to non-streaming with retry so the terminal frame still arrives
      return callAIWithRetry("interviewer", systemPrompt, messages);
    }
  }
  return callAIWithRetry("interviewer", systemPrompt, messages);
}

// ============================================================
// EVALUATOR — real-time signal extraction per answer
// ============================================================

export interface EvalRequest {
  question: string;
  answer: string;
  phase: number;
  stateName: string;
  rubric: Array<{ name: string; weight: number; description: string }>;
  context: string;
}

export interface EvalResult {
  signals: Array<{
    dimension: string;
    signal: string;
    value: number | boolean | string;
    evidence: string;
  }>;
  followUpNeeded: boolean;
  suggestedProbe: string | null;
  flags: string[];
}

const evalResultSchema = z.object({
  signals: z.array(z.object({
    dimension: z.string(),
    signal: z.string(),
    value: z.union([z.number(), z.boolean(), z.string()]),
    evidence: z.string(),
  })),
  followUpNeeded: z.boolean(),
  suggestedProbe: z.string().nullable(),
  flags: z.array(z.string()),
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

  const text = await callAIWithRetry("evaluator", systemPrompt, [
    { role: "user", content: userMessage },
  ]);

  return extractJson(text, evalResultSchema);
}

// ============================================================
// SCORING — final dimension scores after session completes
// ============================================================

const dimensionScoreSchema = z.object({
  dimension: z.string(),
  score: z.number().min(0).max(1),
  evidence: z.string(),
  transcriptIndices: z.array(z.number()),
});

const scoringResultSchema = z.object({
  scores: z.array(dimensionScoreSchema).min(1),
  overall: z.number().min(0).max(1),
});

export async function computeDimensionScores(
  interviewType: InterviewType,
  transcript: Array<{ role: string; content: string; phase: number; stateName: string }>,
  plan: InterviewPlan | CompetencyPlan[] | DomainPlan[],
  tier: InterviewTier
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

  const text = await callAIWithRetry("scorer", systemPrompt, [
    { role: "user", content: userMessage },
  ], 4096);

  const result = extractJson(text, scoringResultSchema);

  const scores: DimensionScore[] = result.scores;
  return {
    scores,
    overall: result.overall,
    hireSignal: calcHireSignal(result.overall, tier),
  };
}

// ============================================================
// REPORT GENERATOR
// ============================================================

const reportBodySchema = z.object({
  strengthSummary: z.string(),
  improvementPlan: z.array(z.object({
    area: z.string(),
    observation: z.string(),
    recommendation: z.string(),
    priority: z.enum(["high", "medium", "low"]),
  })).min(1),
  transcriptEvidence: z.array(z.object({
    claim: z.string(),
    transcriptIndex: z.number().int().min(0),
    quote: z.string(),
    signal: z.enum(["positive", "negative", "neutral"]),
  })),
});

export async function generateReport(
  interviewType: InterviewType,
  sessionId: string,
  dimensionScores: DimensionScore[],
  overall: number,
  hireSignal: HireSignal,
  transcript: Array<{ role: string; content: string; phase: number }>,
  tier: InterviewTier
): Promise<InterviewReport> {
  const systemPrompt = `You are the report generation expert for ${interviewType.replace(/_/g, " ")} interviews.
Write a comprehensive, actionable candidate report. Be specific and constructive.
RESPOND ONLY WITH VALID JSON. NO PREAMBLE.`;

  const last30 = transcript.slice(-30);
  const transcriptText = last30
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

  const text = await callAIWithRetry("scorer", systemPrompt, [
    { role: "user", content: userMessage },
  ], 4096);

  const body = extractJson(text, reportBodySchema);

  const report: InterviewReport = {
    sessionId,
    type: interviewType,
    hireSignal,
    overallScore: overall,
    dimensionScores,
    strengthSummary: body.strengthSummary,
    improvementPlan: body.improvementPlan as ImprovementItem[],
    transcriptEvidence: body.transcriptEvidence as TranscriptEvidence[],
    generatedAt: new Date(),
  };

  return report;
}

// ============================================================
// CLASSIFIERS — fast, use the small model
// ============================================================

export async function detectFirstMove(
  candidateResponse: string
): Promise<"CLARIFY" | "JUMP"> {
  // Heuristic fast path — avoid API call when obvious
  const lower = candidateResponse.toLowerCase();
  const clarifyWords = ["clarif", "question", "mean", "scope", "requirement", "assumption", "constraint", "how many", "what kind", "who are"];
  const jumpWords = ["i would use", "my approach", "the architecture", "load balancer", "microservice", "i'll design", "we need a database", "the system should"];

  const clarifyHits = clarifyWords.filter((w) => lower.includes(w)).length;
  const jumpHits = jumpWords.filter((w) => lower.includes(w)).length;

  if (clarifyHits > jumpHits && clarifyHits > 0) return "CLARIFY";
  if (jumpHits > clarifyHits && jumpHits > 0) return "JUMP";

  // Ambiguous — call AI
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
    const arr = JSON.parse(cleaned);
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}

export async function assessConfidence(answer: string): Promise<{
  overconfident: boolean;
  underconfident: boolean;
}> {
  const lower = answer.toLowerCase();
  const overMarkers = ["always", "definitely", "never fails", "always works", "obviously", "clearly it's", "without a doubt"];
  const underMarkers = ["i think maybe", "i'm not sure but", "probably", "might be wrong", "not totally sure"];

  return {
    overconfident: overMarkers.filter((m) => lower.includes(m)).length >= 2,
    underconfident: underMarkers.filter((m) => lower.includes(m)).length >= 2,
  };
}

export async function classifyProductionDepth(answer: string): Promise<{
  depth: number;
  inflation: boolean;
}> {
  const lower = answer.toLowerCase();
  const prodSignals = ["production", "incident", "outage", "debugging", "on-call", "rollback", "migration", "monitoring", "alert", "postmortem", "p0", "p1", "sev"];
  const tutorialSignals = ["tutorial", "course", "documentation says", "i read that", "theoretically", "from what i understand", "i believe it works by"];

  const prodCount = prodSignals.filter((s) => lower.includes(s)).length;
  const tutCount = tutorialSignals.filter((s) => lower.includes(s)).length;

  return {
    depth: Math.min(1, prodCount / 3),
    inflation: tutCount > prodCount && prodCount < 2,
  };
}

export async function parseStarComponents(
  competency: string,
  answer: string
): Promise<Partial<StarScore>> {
  const systemPrompt = `You are a behavioral interview evaluator. Parse STAR components from this answer.
Score each component 0.0-1.0. Missing components score 0.
RESPOND ONLY WITH VALID JSON.`;

  const schema = z.object({
    situation: z.number().min(0).max(1),
    task: z.number().min(0).max(1),
    action: z.number().min(0).max(1),
    result: z.number().min(0).max(1),
    learning: z.number().min(0).max(1).optional(),
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

export async function detectAttributionFlag(answer: string): Promise<{
  hasFlag: boolean;
  ratio: number;
}> {
  const words = answer.toLowerCase().split(/\s+/);
  const iCount = words.filter((w) => ["i", "i've", "i'd", "i'll", "i'm", "my", "me"].includes(w)).length;
  const weCount = words.filter((w) => ["we", "we've", "we'd", "we'll", "our", "us", "the team"].includes(w)).length;
  const total = iCount + weCount;
  const ratio = total > 0 ? iCount / total : 0.5;

  return {
    hasFlag: ratio < 0.3 && weCount > 4,
    ratio,
  };
}

export async function scoreCoachability(
  challenge: string,
  response: string
): Promise<number> {
  const systemPrompt = `Score this candidate's response to a deliberate challenge. Return ONLY a decimal number 0.0-1.0.

Scoring guide:
1.0 = Engaged + reasoned + acknowledged nuance (ideal arc)
0.8 = Engaged + reasoned, held position with justification
0.6 = Engaged but capitulated without reasoning
0.4 = Partially engaged, mostly deflected
0.2 = Refused to engage or became defensive
0.0 = Ignored the challenge entirely`;

  const text = await callAIWithRetry(
    "classifier",
    systemPrompt,
    [{ role: "user", content: `Challenge: ${challenge}\n\nResponse: ${response}` }],
    10
  );

  const score = parseFloat(text.trim().replace(/[^0-9.]/g, ""));
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0.5;
}