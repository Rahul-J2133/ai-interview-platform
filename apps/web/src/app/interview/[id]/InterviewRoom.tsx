"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useToken } from "../../../hooks/useToken";
import { useInterviewSocket } from "../../../hooks/useInterviewSocket";
import { getSession, abandonSession, type Session } from "../../../lib/api";

interface Message {
  id: string;
  role: "interviewer" | "candidate" | "system";
  content: string;
  isNudge?: boolean;
}

const PHASE_LABELS: Record<string, Record<number, string>> = {
  system_design:    { 0:"Setup", 1:"Delivery", 2:"Requirements", 3:"Estimation", 4:"HLD", 5:"Deep Dive", 6:"Self-Critique", 7:"Scoring" },
  behavioral:       { 0:"Setup", 1:"Warm-up", 2:"Competency 1", 3:"Adversity", 4:"Influence", 5:"Authenticity", 6:"Scoring" },
  domain_knowledge: { 0:"Setup", 1:"Conceptual", 2:"Applied", 3:"Edge Cases", 4:"Domain 2", 5:"Stretch", 6:"Coachability", 7:"Scoring" },
};

const SILENCE_MS = 15_000;

export default function InterviewRoom({ sessionId }: { sessionId: string }) {
  const router   = useRouter();
  const getToken = useToken();

  const [session,    setSession]    = useState<Session | null>(null);
  const [messages,   setMessages]   = useState<Message[]>([]);
  const [input,      setInput]      = useState("");
  const [sending,    setSending]    = useState(false);
  const [phase,      setPhase]      = useState(0);
  const [stateName,  setStateName]  = useState("IDLE");
  const [complete,   setComplete]   = useState(false);
  const [ready,      setReady]      = useState(false);

  const bottomRef    = useRef<HTMLDivElement>(null);
  const textareaRef  = useRef<HTMLTextAreaElement>(null);
  const silenceTimer = useRef<ReturnType<typeof setTimeout>>();

  // Load session metadata once
  useEffect(() => {
    getToken()
      .then((t) => getSession(t, sessionId))
      .then((r) => { if (r.data) setSession(r.data); })
      .catch(console.error);
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Silence detection
  function resetSilence() {
    clearTimeout(silenceTimer.current);
    if (!complete && ready) {
      silenceTimer.current = setTimeout(() => {
        sendSilence();
      }, SILENCE_MS);
    }
  }
  useEffect(() => () => clearTimeout(silenceTimer.current), []);

  // Socket callbacks
  const onInterviewerMessage = useCallback(
    (content: string, isNudge: boolean) => {
      setMessages((m) => [
        ...m,
        { id: crypto.randomUUID(), role: "interviewer", content, isNudge },
      ]);
      setReady(true);
      resetSilence();
    },
    [complete, ready] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const onStateUpdate = useCallback(
    (p: number, s: string, done: boolean) => {
      setPhase(p);
      setStateName(s);
      if (done) setComplete(true);
      if (s.includes("READY") || s.includes("PLAN_READY")) setReady(true);
    },
    []
  );

  const onComplete = useCallback(() => {
    setComplete(true);
    setMessages((m) => [
      ...m,
      {
        id: crypto.randomUUID(),
        role: "system",
        content: "✅ Interview complete — generating your report…",
      },
    ]);
    setTimeout(() => router.push(`/interview/${sessionId}/report`), 3000);
  }, [sessionId, router]);

  const { state: wsState, send, sendSilence } = useInterviewSocket({
    sessionId,
    onInterviewerMessage,
    onStateUpdate,
    onComplete,
  });

  // Send message
  function handleSend() {
    const text = input.trim();
    if (!text || sending || !wsState.connected || complete) return;
    setSending(true);
    setInput("");
    setMessages((m) => [
      ...m,
      { id: crypto.randomUUID(), role: "candidate", content: text },
    ]);
    send(text);
    setSending(false);
    resetSilence();
    // Reset textarea height
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
    resetSilence();
  }

  async function handleAbandon() {
    if (!confirm("Abandon this session?")) return;
    try {
      const t = await getToken();
      await abandonSession(t, sessionId);
    } catch { /* ignore */ }
    router.push("/dashboard");
  }

  const totalPhases = session
    ? Object.keys(PHASE_LABELS[session.type] ?? {}).length
    : 8;
  const phasePct  = ((phase + 1) / totalPhases) * 100;
  const phaseLabel = session
    ? (PHASE_LABELS[session.type]?.[phase] ?? stateName)
    : stateName;

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="flex-none border-b border-gray-800 bg-gray-900/70 backdrop-blur">
        <div className="max-w-3xl mx-auto px-4 py-2.5">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-sm">
              <span className={`w-2 h-2 rounded-full ${
                wsState.connecting ? "bg-yellow-400 animate-pulse" :
                wsState.connected  ? "bg-emerald-400" : "bg-red-400"
              }`} />
              <span className="text-gray-400">
                {wsState.connecting ? "Connecting…" : wsState.connected ? "Live" : "Disconnected"}
              </span>
              {session && (
                <span className="text-gray-500 ml-1">
                  · {session.role} · {session.type.replace("_"," ")} · {session.tier}
                </span>
              )}
            </div>
            <button
              onClick={() => { void handleAbandon(); }}
              className="text-xs text-gray-500 hover:text-gray-300"
            >
              Abandon
            </button>
          </div>

          {/* Progress bar */}
          <div className="flex items-center gap-2">
            <div className="flex-1 bg-gray-800 rounded-full h-1.5">
              <div
                className="bg-indigo-500 h-1.5 rounded-full transition-all duration-500"
                style={{ width: `${phasePct}%` }}
              />
            </div>
            <span className="text-xs text-gray-500 whitespace-nowrap">
              {phaseLabel} ({phase + 1}/{totalPhases})
            </span>
          </div>

          {wsState.error && (
            <p className="text-xs text-red-400 mt-1">{wsState.error}</p>
          )}
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
          {messages.length === 0 && (
            <div className="text-center py-16 text-gray-500 text-sm">
              <div className="text-3xl mb-2 animate-pulse">⟳</div>
              Preparing your interview…
            </div>
          )}

          {messages.map((msg) => {
            if (msg.role === "system") {
              return (
                <div key={msg.id} className="text-center">
                  <span className="inline-block bg-gray-800 text-gray-400 text-xs px-4 py-1.5 rounded-full">
                    {msg.content}
                  </span>
                </div>
              );
            }

            const isCandidate = msg.role === "candidate";
            return (
              <div key={msg.id} className={`flex ${isCandidate ? "justify-end" : "justify-start"}`}>
                <div className="max-w-[80%]">
                  <div className={`text-xs text-gray-500 mb-1 ${isCandidate ? "text-right" : ""}`}>
                    {isCandidate ? "You" : msg.isNudge ? "💬 Interviewer (nudge)" : "🤖 Interviewer"}
                  </div>
                  <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                    isCandidate
                      ? "bg-indigo-600 text-white rounded-br-sm"
                      : msg.isNudge
                      ? "bg-amber-900/30 border border-amber-800/40 text-amber-200 rounded-bl-sm"
                      : "bg-gray-800 text-gray-100 rounded-bl-sm"
                  }`}>
                    {msg.content}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      {!complete && (
        <div className="flex-none border-t border-gray-800 bg-gray-900/70 backdrop-blur">
          <div className="max-w-3xl mx-auto px-4 py-3">
            <div className="flex items-end gap-2">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                disabled={!ready || !wsState.connected || sending}
                placeholder={
                  !ready           ? "Waiting for interviewer…" :
                  !wsState.connected ? "Reconnecting…" :
                  "Answer here… (Enter to send, Shift+Enter for new line)"
                }
                rows={1}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 disabled:opacity-40 resize-none transition-colors"
                style={{ minHeight: "44px", maxHeight: "160px" }}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || !ready || !wsState.connected || sending}
                className="flex-none h-11 w-11 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-xl flex items-center justify-center transition-colors"
              >
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
              </button>
            </div>
            <div className="text-xs text-gray-600 mt-1.5 text-center">
              Phase {phase + 1} · {stateName}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
