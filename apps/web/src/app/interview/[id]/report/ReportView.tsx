"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useToken } from "../../../../hooks/useToken";
import {
  getReport, getTranscript,
  type Report, type TranscriptMessage,
} from "../../../../lib/api";

const SIGNAL_CONFIG = {
  strong_hire:    { label: "Strong Hire",    color: "text-emerald-400", bg: "border-emerald-500/30 bg-emerald-500/10" },
  hire:           { label: "Hire",           color: "text-green-400",   bg: "border-green-500/30 bg-green-500/10" },
  no_hire:        { label: "No Hire",        color: "text-amber-400",   bg: "border-amber-500/30 bg-amber-500/10" },
  strong_no_hire: { label: "Strong No Hire", color: "text-red-400",     bg: "border-red-500/30 bg-red-500/10" },
} as const;

function ScoreBar({ label, score }: { label: string; score: number }) {
  const pct = Math.round(score * 100);
  const color =
    pct >= 80 ? "bg-emerald-500" :
    pct >= 60 ? "bg-green-500"   :
    pct >= 40 ? "bg-amber-500"   :
    "bg-red-500";
  return (
    <div>
      <div className="flex justify-between mb-1">
        <span className="text-sm text-gray-300">{label.replace(/_/g," ")}</span>
        <span className="text-sm font-medium text-white">{pct}%</span>
      </div>
      <div className="bg-gray-800 rounded-full h-1.5">
        <div
          className={`${color} h-1.5 rounded-full transition-all duration-700`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function ReportView({ sessionId }: { sessionId: string }) {
  const router   = useRouter();
  const getToken = useToken();

  const [report,     setReport]     = useState<Report | null>(null);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [tab,        setTab]        = useState<"overview" | "transcript">("overview");
  const [loading,    setLoading]    = useState(true);
  const [pollCount,  setPollCount]  = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const t   = await getToken();
        const res = await getReport(t, sessionId);

        if (cancelled) return;

        if (res.error?.code === "NOT_COMPLETE" && pollCount < 12) {
          // Report still generating — poll every 5 s, up to 1 min
          setTimeout(() => setPollCount((c) => c + 1), 5000);
          return;
        }

        if (res.data) {
          setReport(res.data);
          const tr = await getTranscript(t, sessionId);
          if (!cancelled && tr.data) setTranscript(tr.data);
        }
      } catch (err) {
        console.error(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [pollCount]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading || (!report && pollCount < 12)) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center text-gray-400">
        <div className="text-4xl mb-3 animate-spin">⟳</div>
        <p className="font-medium">Generating your report…</p>
        <p className="text-sm text-gray-500 mt-1">This takes about 30–60 seconds</p>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400">Report unavailable</p>
          <button onClick={() => router.push("/dashboard")} className="mt-3 text-sm text-indigo-400 hover:text-indigo-300">
            ← Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  const sig = SIGNAL_CONFIG[report.hireSignal] ?? SIGNAL_CONFIG.no_hire;

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/60 backdrop-blur sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-5 py-3 flex items-center justify-between">
          <button
            onClick={() => router.push("/dashboard")}
            className="text-sm text-gray-400 hover:text-white transition-colors"
          >
            ← Dashboard
          </button>
          <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
            {(["overview","transcript"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1 rounded-md text-sm transition-colors ${
                  tab === t ? "bg-gray-700 text-white" : "text-gray-400 hover:text-white"
                }`}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-5 py-8 space-y-6">

        {/* Signal hero */}
        <div className={`border rounded-2xl p-6 ${sig.bg}`}>
          <div className="flex items-center justify-between">
            <div>
              <div className={`text-2xl font-bold ${sig.color}`}>{sig.label}</div>
              <div className="text-sm text-gray-400 mt-0.5">
                {report.type.replace("_"," ")} interview
              </div>
            </div>
            <div className="text-right">
              <div className="text-4xl font-bold text-white">
                {Math.round(report.overallScore * 100)}
                <span className="text-xl text-gray-400">%</span>
              </div>
              <div className="text-xs text-gray-500 mt-0.5">Overall score</div>
            </div>
          </div>
        </div>

        {tab === "overview" && (
          <>
            {/* Summary */}
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
              <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-3">Summary</h3>
              <p className="text-sm text-gray-200 leading-relaxed">{report.strengthSummary}</p>
            </div>

            {/* Dimension scores */}
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
              <h3 className="text-xs text-gray-500 uppercase tracking-wider">Dimension scores</h3>
              {report.dimensionScores.map((d) => (
                <ScoreBar key={d.dimension} label={d.dimension} score={d.score} />
              ))}
            </div>

            {/* Improvement plan */}
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
              <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-3">Improvement plan</h3>
              <div className="space-y-3">
                {report.improvementPlan.map((item, i) => {
                  const borderColor =
                    item.priority === "high"   ? "border-red-500/30 bg-red-500/5" :
                    item.priority === "medium" ? "border-amber-500/30 bg-amber-500/5" :
                    "border-gray-700 bg-gray-800/30";
                  const tagColor =
                    item.priority === "high"   ? "text-red-400" :
                    item.priority === "medium" ? "text-amber-400" : "text-gray-400";
                  return (
                    <div key={i} className={`border rounded-xl p-4 ${borderColor}`}>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-sm font-medium text-white">{item.area}</span>
                        <span className={`text-xs ${tagColor}`}>{item.priority}</span>
                      </div>
                      <p className="text-xs text-gray-400 mb-1.5">{item.observation}</p>
                      <p className="text-sm text-gray-200">
                        <span className="text-indigo-400 mr-1">→</span>
                        {item.recommendation}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {tab === "transcript" && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-4">Full transcript</h3>
            {transcript.length === 0 ? (
              <p className="text-sm text-gray-500">No transcript available.</p>
            ) : (
              <div className="space-y-4">
                {transcript
                  .filter((m) => m.role !== "system")
                  .map((m) => (
                    <div
                      key={m.id}
                      className={`flex ${m.role === "candidate" ? "justify-end" : "justify-start"}`}
                    >
                      <div className="max-w-[80%]">
                        <div className={`text-xs text-gray-600 mb-1 ${m.role === "candidate" ? "text-right" : ""}`}>
                          {m.role === "interviewer" ? "Interviewer" : "You"} · phase {m.phase}
                        </div>
                        <div className={`text-sm rounded-xl px-3 py-2 whitespace-pre-wrap ${
                          m.role === "candidate"
                            ? "bg-indigo-900/40 text-gray-200"
                            : "bg-gray-800 text-gray-300"
                        }`}>
                          {m.content}
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
