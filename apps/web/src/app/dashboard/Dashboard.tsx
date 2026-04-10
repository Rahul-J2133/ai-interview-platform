"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useToken } from "../../hooks/useToken";
import {
  listSessions, createSession, parseDocument,
  type Session, type InterviewType, type InterviewTier, type InterviewLevel,
} from "../../lib/api";

// ── constants ──────────────────────────────────────────────

const TYPES: { value: InterviewType; label: string; icon: string; desc: string }[] = [
  { value: "system_design",    label: "System Design",    icon: "🏗️", desc: "Scale, trade-offs, HLD" },
  { value: "behavioral",       label: "Behavioral",       icon: "🧠", desc: "STAR format, adversity, influence" },
  { value: "domain_knowledge", label: "Domain Knowledge", icon: "📚", desc: "Conceptual depth, production signal" },
];

const HIRE_COLOR: Record<string, string> = {
  strong_hire:    "text-emerald-400",
  hire:           "text-green-400",
  no_hire:        "text-amber-400",
  strong_no_hire: "text-red-400",
};

// ── component ──────────────────────────────────────────────

export default function Dashboard() {
  const router    = useRouter();
  const getToken  = useToken();

  const [sessions, setSessions]     = useState<Session[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showForm, setShowForm]     = useState(false);
  const [creating, setCreating]     = useState(false);
  const [uploadMsg, setUploadMsg]   = useState("");
  const fileRef                     = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState<{
    type: InterviewType;
    tier: InterviewTier;
    level: InterviewLevel;
    role: string;
    jdText: string;
    parsedResumeText: string;
  }>({
    type: "system_design",
    tier: "T2",
    level: "mid",
    role: "",
    jdText: "",
    parsedResumeText: "",
  });

  // Load session list
  useEffect(() => {
    getToken()
      .then((t) => listSessions(t))
      .then((r) => { if (r.data) setSessions(r.data); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Upload resume file → extract text via API
  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadMsg("Extracting text…");
    try {
      const t   = await getToken();
      const res = await parseDocument(t, file);
      if (res.data) {
        setForm((f) => ({ ...f, parsedResumeText: res.data!.text }));
        setUploadMsg(`✓ Extracted ${res.data.charCount.toLocaleString()} characters (${res.data.meta.skills.length} skills detected)`);
      } else {
        setUploadMsg(`✗ ${res.error?.message ?? "Upload failed"}`);
      }
    } catch (err) {
      setUploadMsg(`✗ ${String(err)}`);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.role.trim()) return;
    setCreating(true);
    try {
      const t   = await getToken();
      const res = await createSession(t, {
        type:             form.type,
        tier:             form.tier,
        level:            form.level,
        role:             form.role.trim(),
        jdText:           form.jdText || null,
        parsedResumeText: form.parsedResumeText || null,
      });
      if (res.data) {
        router.push(`/interview/${res.data.id}`);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/60 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-5 py-3 flex items-center justify-between">
          <span className="font-semibold text-white">AI Interview Platform</span>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="text-sm bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-1.5 rounded-lg transition-colors"
          >
            {showForm ? "Cancel" : "+ New interview"}
          </button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-5 py-8 space-y-8">

        {/* New session form */}
        {showForm && (
          <form
            onSubmit={(e) => { void handleCreate(e); }}
            className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-5"
          >
            <h2 className="font-semibold text-white">New Interview Session</h2>

            {/* Type selector */}
            <div className="grid grid-cols-3 gap-3">
              {TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, type: t.value }))}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    form.type === t.value
                      ? "border-indigo-500 bg-indigo-500/10"
                      : "border-gray-700 hover:border-gray-600"
                  }`}
                >
                  <div className="text-xl mb-1">{t.icon}</div>
                  <div className="text-sm font-medium text-white">{t.label}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{t.desc}</div>
                </button>
              ))}
            </div>

            {/* Role */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Target role *</label>
              <input
                required
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                placeholder="e.g. Senior Software Engineer"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
              />
            </div>

            {/* Level + Tier */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Level</label>
                <select
                  value={form.level}
                  onChange={(e) => setForm((f) => ({ ...f, level: e.target.value as InterviewLevel }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                >
                  {(["junior","mid","senior","staff","principal"] as InterviewLevel[]).map((l) => (
                    <option key={l} value={l}>{l.charAt(0).toUpperCase() + l.slice(1)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Interview bar</label>
                <select
                  value={form.tier}
                  onChange={(e) => setForm((f) => ({ ...f, tier: e.target.value as InterviewTier }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                >
                  <option value="T1">T1 — FAANG / top-tier</option>
                  <option value="T2">T2 — Standard</option>
                  <option value="T3">T3 — Early stage</option>
                </select>
              </div>
            </div>

            {/* JD */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Job description (optional)</label>
              <textarea
                rows={3}
                value={form.jdText}
                onChange={(e) => setForm((f) => ({ ...f, jdText: e.target.value }))}
                placeholder="Paste the JD for more targeted questions…"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 resize-none"
              />
            </div>

            {/* Resume upload */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Resume (optional — PDF, DOCX, or TXT)</label>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.docx,.txt"
                onChange={(e) => { void handleFileUpload(e); }}
                className="hidden"
              />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="text-sm bg-gray-800 border border-gray-700 hover:border-gray-500 text-gray-300 px-3 py-1.5 rounded-lg transition-colors"
                >
                  Upload file
                </button>
                {uploadMsg && (
                  <span className={`text-xs ${uploadMsg.startsWith("✓") ? "text-emerald-400" : uploadMsg.startsWith("✗") ? "text-red-400" : "text-gray-400"}`}>
                    {uploadMsg}
                  </span>
                )}
              </div>
            </div>

            <button
              type="submit"
              disabled={creating || !form.role.trim()}
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white py-2.5 rounded-xl font-medium text-sm transition-colors"
            >
              {creating ? "Setting up…" : "Start interview"}
            </button>
          </form>
        )}

        {/* Session list */}
        <div>
          <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
            Past sessions
          </h2>

          {loading ? (
            <div className="text-center py-12 text-gray-500 text-sm">Loading…</div>
          ) : sessions.length === 0 ? (
            <div className="text-center py-12 text-gray-500 text-sm">
              No interviews yet — start one above.
            </div>
          ) : (
            <div className="space-y-2">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  onClick={() =>
                    s.status === "completed"
                      ? router.push(`/interview/${s.id}/report`)
                      : router.push(`/interview/${s.id}`)
                  }
                  className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-4 flex items-center justify-between cursor-pointer transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xl">
                      {TYPES.find((t) => t.value === s.type)?.icon}
                    </span>
                    <div>
                      <div className="text-sm font-medium text-white">{s.role}</div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {s.type.replace("_", " ")} · {s.level} · {s.tier}
                      </div>
                    </div>
                  </div>

                  <div className="text-right">
                    <div className={`text-sm font-medium ${
                      s.hireSignal
                        ? (HIRE_COLOR[s.hireSignal] ?? "text-gray-400")
                        : "text-gray-500"
                    }`}>
                      {s.hireSignal
                        ? s.hireSignal.replace("_", " ")
                        : s.status}
                    </div>
                    {s.overallScore !== null && (
                      <div className="text-xs text-gray-600 mt-0.5">
                        {Math.round(s.overallScore * 100)}%
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
