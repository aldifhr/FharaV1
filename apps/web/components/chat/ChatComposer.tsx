"use client";

import { useState, useRef } from "react";
import { AtSign, ChevronDown, ChevronUp, Edit2, Loader2, Mic, Paperclip, Send, Sparkles, Type, X } from "lucide-react";
import InitialAvatar from "../InitialAvatar";
import { roleLabel } from "@/lib/agentRoles";
import { useAutoGrowRef, type QueuedMessage } from "./useChatQueue";

export default function ChatComposer({
  draft,
  onDraftChange,
  onSend,
  onQueue,
  sending,
  error,
  mention,
  mentionResults,
  onInsertMention,
  queue,
  editingId,
  onEdit,
  onEditContent,
  onMove,
  onRemove,
  onSendAll,
  agents,
  chatAgentIds,
  onToggleAgent,
  projectName,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onQueue: () => void;
  sending: boolean;
  error: string;
  mention: string | null;
  mentionResults: string[];
  onInsertMention: (path: string) => void;
  queue: QueuedMessage[];
  editingId: string | null;
  onEdit: (id: string | null) => void;
  onEditContent: (id: string, content: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
  onSendAll: () => void;
  agents: any[];
  chatAgentIds: string[];
  onToggleAgent: (agentId: string) => void;
  projectName: string;
}) {
  return (
    <div className="border-t border-[#ebe9f0] bg-white/80 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-950/80">
      <div className="relative flex flex-col gap-2">
        {mention !== null && mentionResults.length > 0 && (
          <ul className="absolute bottom-full left-0 z-30 mb-2 max-h-52 w-full overflow-y-auto rounded-xl border border-[#e5e3eb] bg-white py-1 shadow-xl dark:border-gray-700 dark:bg-gray-900">
            {mentionResults.map((path) => (
              <li key={path}>
                <button
                  type="button"
                  onClick={() => onInsertMention(path)}
                  className="block w-full truncate px-3 py-1.5 text-left font-mono text-xs hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  @{path}
                </button>
              </li>
            ))}
          </ul>
        )}

        {queue.length > 0 && (
          <div className="space-y-1.5">
            {queue.map((item, idx) => (
              <div
                key={item.id}
                className={`flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${
                  item.status === "sending"
                    ? "border-sky-300 bg-sky-50 dark:border-sky-700 dark:bg-sky-950/50"
                    : item.status === "sent"
                    ? "border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/50"
                    : item.status === "failed"
                    ? "border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950/50"
                    : "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
                }`}
              >
                <span className="shrink-0 pt-0.5 font-mono text-gray-400">{idx + 1}.</span>
                {editingId === item.id ? (
                  <input
                    autoFocus
                    value={item.content}
                    onChange={(e) => onEditContent(item.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); onEdit(null); }
                      if (e.key === "Escape") onEdit(null);
                    }}
                    className="min-w-0 flex-1 rounded border border-indigo-300 bg-white px-1.5 py-0.5 text-xs dark:border-indigo-700 dark:bg-gray-800"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">
                    {item.content}
                  </span>
                )}
                <span
                  className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold ${
                    item.status === "queued"
                      ? "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                      : item.status === "sending"
                      ? "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300"
                      : item.status === "sent"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300"
                      : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
                  }`}
                >
                  {item.status}
                </span>
                {item.status === "queued" && (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => onMove(item.id, -1)}
                      disabled={idx === 0}
                      className="rounded p-0.5 text-gray-400 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-20 dark:hover:bg-gray-800"
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onMove(item.id, 1)}
                      disabled={idx === queue.length - 1}
                      className="rounded p-0.5 text-gray-400 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-20 dark:hover:bg-gray-800"
                    >
                      <ChevronDown size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onEdit(item.id)}
                      className="rounded p-0.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                    >
                      <Edit2 size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(item.id)}
                      className="rounded p-0.5 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <ComposerInput
          draft={draft}
          projectName={projectName}
          mentionActive={mention !== null && mentionResults.length > 0}
          onChange={onDraftChange}
          onSend={onSend}
          onQueue={onQueue}
          onInsertFirstMention={mentionResults[0] ? () => onInsertMention(mentionResults[0]) : undefined}
        />

        <div className="mt-2 flex items-center gap-1.5">
          <button type="button" title="Formatting (not available)" aria-label="Formatting (not available)" disabled className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-300 dark:text-gray-600 cursor-not-allowed"><Type size={16} /></button>
          <button type="button" title="Attach a file (not available)" aria-label="Attach a file (not available)" disabled className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-300 dark:text-gray-600 cursor-not-allowed"><Paperclip size={16} /></button>
          <button
            type="button"
            onClick={() => onDraftChange(`${draft}@`)}
            title="Reference a file"
            aria-label="Reference a file"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          >
            <AtSign size={15} />
          </button>
          <button type="button" title="Voice input (not available)" aria-label="Voice input (not available)" disabled className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-300 dark:text-gray-600 cursor-not-allowed"><Mic size={16} /></button>
          <select value="" onChange={(event) => { if (event.target.value) onToggleAgent(event.target.value); }} aria-label="Select agents to route to" className="h-7 max-w-28 rounded-full border border-[#e5e3eb] bg-white px-2 text-xs text-gray-500 outline-none focus:border-[#a29ae8] dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"><option value="">Route to…</option>{agents.filter((a: any) => !chatAgentIds.includes(a._id)).map((a: any) => <option key={a._id} value={a._id}>{roleLabel(a.role)}</option>)}</select>
          {(() => { const cto = agents.find((a: any) => /^(cto|orchestrator|planner|architect)$/i.test(a.role ?? "")); return cto && !chatAgentIds.includes(cto._id) ? <button type="button" onClick={() => onToggleAgent(cto._id)} className="h-7 rounded-full border border-[#e5e3eb] px-2.5 text-xs font-semibold text-gray-600 hover:border-[#a29ae8] hover:text-[#5147b4] dark:border-gray-700 dark:text-gray-300" aria-label="Delegate to CTO">Delegate to CTO</button> : null; })()}
          {agents
            .filter((a: any) => chatAgentIds.includes(a._id))
            .map((a: any) => (
              <button
                key={a._id}
                type="button"
                onClick={() => onToggleAgent(a._id)}
                title={`Stop routing to ${roleLabel(a.role)}`}
                className="flex h-7 items-center gap-1.5 rounded-full bg-[#eeecfb] px-2.5 py-1 text-xs font-semibold text-[#5147b4] transition hover:bg-[#e2defa] dark:bg-indigo-950 dark:text-indigo-300 dark:hover:bg-indigo-900"
              >
                <InitialAvatar name={roleLabel(a.role)} size={16} /> To {roleLabel(a.role)} <X size={11} />
              </button>
            ))}
          <span className="ml-auto hidden text-[11px] text-gray-400 sm:block">Enter to send</span>
          {queue.length > 0 ? (
            <button
              onClick={onSendAll}
              disabled={sending || !queue.some((m) => m.status === "queued")}
              className="flex items-center gap-1 rounded-xl bg-[#635bff] px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-[#5346d8] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send size={14} /> Send all
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={sending || !draft.trim()}
              aria-label="Send message"
              className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#635bff] text-white shadow-sm transition hover:bg-[#5346d8] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function ComposerInput({
  draft,
  projectName,
  mentionActive,
  onChange,
  onSend,
  onQueue,
  onInsertFirstMention,
}: {
  draft: string;
  projectName: string;
  mentionActive: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onQueue: () => void;
  onInsertFirstMention?: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceError, setEnhanceError] = useState("");

  // Auto-grow textarea as draft changes
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEnhanceError("");
    onChange(e.target.value);
    // Auto-grow without useEffect
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  const handleEnhance = async () => {
    if (!draft.trim() || enhancing) return;

    setEnhancing(true);
    try {
      const response = await fetch("/api/magic-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: draft }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Enhancement failed" }));
        console.error("Magic prompt error:", error.error);
        setEnhanceError(error.error || "Enhancement failed");
        return;
      }

      const data = await response.json() as { enhanced?: string };
      if (data.enhanced) {
        setEnhanceError("");
        onChange(data.enhanced);
      }
    } catch (err) {
      console.error("Magic prompt failed:", err);
      setEnhanceError(err instanceof Error ? err.message : "Enhancement failed");
    } finally {
      setEnhancing(false);
    }
  };

  return (
    <div className="rounded-2xl border border-[#e5e3eb] bg-white px-4 pb-3 pt-3.5 shadow-sm transition focus-within:border-[#a29ae8] focus-within:ring-2 focus-within:ring-[#e5e1ff] dark:border-gray-700 dark:bg-gray-800 dark:focus-within:border-indigo-400 dark:focus-within:ring-indigo-900">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={handleChange}
          onKeyDown={(e) => {
            if (mentionActive && e.key === "Enter") {
              e.preventDefault();
              onInsertFirstMention?.();
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
            if (e.key === "Enter" && e.shiftKey) {
              e.preventDefault();
              onQueue();
            }
          }}
          rows={1}
          placeholder={`Message ${projectName}, or @ a file`}
          className="w-full resize-none bg-transparent px-0.5 text-[15px] leading-6 text-gray-900 outline-none placeholder:text-gray-400 dark:text-white dark:placeholder:text-gray-400"
          style={{ minHeight: "24px", maxHeight: "120px" }}
        />
        {draft.trim() && !enhancing && (
          <button
            type="button"
            onClick={handleEnhance}
            title="Enhance prompt with AI"
            aria-label="Enhance prompt with AI"
            className="shrink-0 rounded-lg p-1.5 text-gray-400 transition hover:bg-[#e5e1ff] hover:text-[#635bff] dark:hover:bg-indigo-900 dark:hover:text-indigo-300"
          >
            <Sparkles size={16} />
          </button>
        )}
        {enhancing && (
          <button
            type="button"
            disabled
            title="Enhancing prompt..."
            aria-label="Enhancing prompt"
            className="shrink-0 rounded-lg p-1.5 text-[#635bff] dark:text-indigo-300"
          >
            <Loader2 size={16} className="animate-spin" />
          </button>
        )}
      </div>
      {enhanceError && (
        <p role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">{enhanceError}</p>
      )}
    </div>
  );
}
