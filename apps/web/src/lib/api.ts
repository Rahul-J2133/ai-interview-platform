/**
 * Typed API client.
 * Every function takes a Clerk JWT string (from useAuth().getToken())
 * and returns a typed result. No global state, no singletons.
 */

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// ── TYPES (minimal — mirrors API response shapes) ─────────

export type InterviewType  = "system_design" | "behavioral" | "domain_knowledge";
export type InterviewTier  = "T1" | "T2" | "T3";
export type InterviewLevel = "junior" | "mid" | "senior" | "staff" | "principal";
export type HireSignal     = "strong_hire" | "hire" | "no_hire" | "strong_no_hire";
export type SessionStatus  = "initializing" | "ready" | "active" | "paused" | "completed" | "abandoned";

export interface Session {
  id: string;
  type: InterviewType;
  tier: InterviewTier;
  level: InterviewLevel;
  role: string;
  status: SessionStatus;
  currentPhase: number;
  hireSignal: HireSignal | null;
  overallScore: number | null;
  createdAt: string;
  completedAt: string | null;
  liveState?: { stateName: string; phase: number; isActive: boolean } | null;
}

export interface TranscriptMessage {
  id: string;
  role: "interviewer" | "candidate" | "system";
  type: string;
  content: string;
  phase: number;
  stateName: string;
  sequenceIndex: number;
}

export interface DimensionScore {
  dimension: string;
  score: number;
  evidence: string;
}

export interface ImprovementItem {
  area: string;
  observation: string;
  recommendation: string;
  priority: "high" | "medium" | "low";
}

export interface Report {
  sessionId: string;
  type: InterviewType;
  hireSignal: HireSignal;
  overallScore: number;
  strengthSummary: string;
  dimensionScores: DimensionScore[];
  improvementPlan: ImprovementItem[];
  generatedAt: string;
}

export interface ApiError {
  code: string;
  message: string;
}

export interface ApiResult<T> {
  data: T | null;
  error: ApiError | null;
}

export interface ParsedDoc {
  text: string;
  charCount: number;
  fileType: "pdf" | "docx" | "txt";
  meta: {
    sections: string[];
    skills: string[];
    yearsExperience: number | null;
    isResume: boolean;
    chunkCount: number;
  };
}

// ── FETCH HELPER ──────────────────────────────────────────

async function req<T>(
  path: string,
  token: string,
  init: RequestInit = {}
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
    const json = (await res.json()) as ApiResult<T>;
    return json;
  } catch (err) {
    return { data: null, error: { code: "NETWORK_ERROR", message: String(err) } };
  }
}

// ── USERS ────────────────────────────────────────────────

export async function getMe(token: string) {
  return req<{ id: string; email: string; fullName: string | null; stats: unknown }>(
    "/api/v1/users/me", token
  );
}

// ── SESSIONS ─────────────────────────────────────────────

export async function createSession(
  token: string,
  body: {
    type: InterviewType;
    tier: InterviewTier;
    level: InterviewLevel;
    role: string;
    jdText?: string | null;
    resumeText?: string | null;
    parsedResumeText?: string | null;
  }
): Promise<ApiResult<Session>> {
  return req<Session>("/api/v1/sessions", token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function listSessions(
  token: string,
  params?: { type?: InterviewType; status?: SessionStatus; page?: number }
): Promise<ApiResult<Session[]>> {
  const qs = new URLSearchParams();
  if (params?.type)   qs.set("type",   params.type);
  if (params?.status) qs.set("status", params.status);
  if (params?.page)   qs.set("page",   String(params.page));
  return req<Session[]>(`/api/v1/sessions?${qs}`, token);
}

export async function getSession(token: string, id: string): Promise<ApiResult<Session>> {
  return req<Session>(`/api/v1/sessions/${id}`, token);
}

export async function getTranscript(
  token: string, id: string
): Promise<ApiResult<TranscriptMessage[]>> {
  return req<TranscriptMessage[]>(`/api/v1/sessions/${id}/transcript`, token);
}

export async function getReport(token: string, id: string): Promise<ApiResult<Report>> {
  return req<Report>(`/api/v1/sessions/${id}/report`, token);
}

export async function abandonSession(token: string, id: string) {
  return req<{ abandoned: boolean }>(`/api/v1/sessions/${id}/abandon`, token, {
    method: "POST",
  });
}

// ── SSE STREAM AUTH ───────────────────────────────────────
//
// The hardened API no longer accepts a JWT in the SSE query string.
// Instead:
//   1. Call getStreamToken() with a valid JWT to obtain a short-lived nonce.
//   2. Open the SSE stream using that nonce via getStreamUrl().
//
// The nonce is single-use and expires in 30 seconds.

export async function getStreamToken(
  token: string,
  sessionId: string
): Promise<ApiResult<{ nonce: string; expiresIn: number }>> {
  return req<{ nonce: string; expiresIn: number }>(
    `/api/v1/sessions/${sessionId}/stream-token`,
    token,
    { method: "POST" }
  );
}

/** Build the SSE stream URL from a nonce (never includes the JWT). */
export function getStreamUrl(sessionId: string, nonce: string): string {
  return `${BASE}/api/v1/sessions/${sessionId}/stream?nonce=${encodeURIComponent(nonce)}`;
}

// ── SSE MESSAGING ─────────────────────────────────────────
//
// Candidate messages and silence events are sent as separate HTTP
// POST requests rather than through the SSE connection itself.

export async function sendCandidateMessage(
  token: string,
  sessionId: string,
  content: string
): Promise<ApiResult<{ queued: boolean }>> {
  return req<{ queued: boolean }>(
    `/api/v1/sessions/${sessionId}/message`,
    token,
    { method: "POST", body: JSON.stringify({ content }) }
  );
}

export async function sendSilenceEvent(
  token: string,
  sessionId: string
): Promise<ApiResult<{ queued: boolean }>> {
  return req<{ queued: boolean }>(
    `/api/v1/sessions/${sessionId}/silence`,
    token,
    { method: "POST" }
  );
}

// ── DOCUMENTS ────────────────────────────────────────────

export async function parseDocument(
  token: string,
  file: File
): Promise<ApiResult<ParsedDoc>> {
  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch(`${BASE}/api/v1/documents/parse`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      // No Content-Type — browser sets multipart boundary automatically
      body: form,
    });
    return (await res.json()) as ApiResult<ParsedDoc>;
  } catch (err) {
    return { data: null, error: { code: "UPLOAD_ERROR", message: String(err) } };
  }
}
