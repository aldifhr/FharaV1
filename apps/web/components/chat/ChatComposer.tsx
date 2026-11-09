"use client";

import { useEffect, useState } from "react";
import { AtSign, ChevronDown, ChevronUp, Edit2, Loader2, RotateCcw, Send, Sparkles, X } from "lucide-react";
import { roleLabel, ROLE_COLORS, roleKeyForMention, NEUTRAL_MENTION_COLOR } from "@/lib/agentRoles";
import { useAutoGrowRef, type QueuedMessage } from "./useChatQueue";

type MentionAgent = { _id: string; name: string; role: string };
type MentionOption = { kind: "agent"; agent: MentionAgent } | { kind: "file"; path: string };

const iconBtn =
  "flex h-7 w-7 items-center justify-center rounded-md text-gray-500 outline-none transition hover:bg-gray-100 hover:text-gray-800 focus-visible:ring-2 focus-visible:ring-[#635bff]/40 disabled:cursor-not-allowed disabled:opacity-30 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200";

export default function ChatComposer({
  draft,
  onDraftChange,
  onSend,
  onQueue,
  sending,
  error,
  mention,
  mentionResults,
  agentResults,
  onInsertMention,
  onInsertAgent,
  onDismissMention,
  queue,
  editingId,
  onEdit,
  onEditContent,
  onMove,
  onRemove,
  onRetry,
  onSendAll,
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
  agentResults: MentionAgent[];
  onInsertMention: (path: string) => void;
  onInsertAgent: (agent: MentionAgent) => void;
  onDismissMention: () => void;
  queue: QueuedMessage[];
  editingId: string | null;
  onEdit: (id: string | null) => void;
  onEditContent: (id: string, content: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onSendAll: () => void;
  projectName: string;
}) {
  // Teammates first, then files: one keyboard-navigable list.
  const options: MentionOption[] = [
    ...agentResults.map((agent) => ({ kind: "agent" as const, agent })),
    ...mentionResults.map((path) => ({ kind: "file" as const, path })),
  ];
  const mentionOpen = mention !== null && options.length > 0;
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => setActiveIndex(0), [mention, options.length]);

  const choose = (option: MentionOption | undefined) => {
    if (!option) return;
    if (option.kind === "agent") onInsertAgent(option.agent);
    else onInsertMention(option.path);
  };
  const pendingCount = queue.filter((m) => m.status === "queued" || m.status === "failed").length;

  return (
    <div className="shrink-0 border-t border-[#ebe9f0] bg-white/80 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-950/80">
      <div className="relative flex flex-col gap-2">
        {mentionOpen && (
          <ul
            id="composer-mentions"
            role="listbox"
            aria-label="Mention a teammate or file"
            className="absolute bottom-full left-0 z-30 mb-2 max-h-60 w-full overflow-y-auto rounded-xl border border-[#e5e3eb] bg-white py-1 shadow-xl dark:border-gray-700 dark:bg-gray-900"
          >
            {agentResults.length > 0 && (
              <li role="presentation" className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Team</li>
            )}
            {options.map((option, index) => {
              const active = index === activeIndex;
              const id = `composer-mention-${index}`;
              const firstFile = option.kind === "file" && index === agentResults.length;
              if (option.kind === "agent") {
                const key = roleKeyForMention(option.agent.role);
                return (
                  <li key={option.agent._id} id={id} role="option" aria-selected={active}>
                    <button
                      type="button"
                      tabIndex={-1}
                      onMouseEnter={() => setActiveIndex(index)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(option)}
                      className={`flex w-full items-center gap-2 truncate px-3 py-2 text-left text-sm ${active ? "bg-gray-100 dark:bg-gray-800" : ""}`}
                    >
                      <span className={`rounded-md px-1.5 py-px text-[13px] font-semibold ring-1 ring-inset ${key ? ROLE_COLORS[key] : NEUTRAL_MENTION_COLOR}`}>
                        @{roleLabel(option.agent.role)}
                      </span>
                      {option.agent.name && option.agent.name !== roleLabel(option.agent.role) && (
                        <span className="truncate text-xs text-gray-500 dark:text-gray-400">{option.agent.name}</span>
                      )}
                    </button>
                  </li>
                );
              }
              return [
                firstFile ? (
                  <li key="files-heading" role="presentation" className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Files</li>
                ) : null,
                <li key={option.path} id={id} role="option" aria-selected={active}>
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(option)}
                    className={`block w-full truncate px-3 py-2 text-left font-mono text-xs text-gray-700 dark:text-gray-200 ${active ? "bg-gray-100 dark:bg-gray-800" : ""}`}
                  >
                    @{option.path}
                  </button>
                </li>,
              ];
            })}
          </ul>
        )}

        {queue.length > 0 && (
          <ul className="space-y-1.5" aria-label="Queued messages">
            {queue.map((item, idx) => {
              const editable = item.status === "queued" || item.status === "failed";
              return (
                <li
                  key={item.id}
                  className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs ${
                    item.status === "sending"
                      ? "border-sky-300 bg-sky-50 dark:border-sky-800 dark:bg-sky-950/50"
                      : item.status === "sent"
                        ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/50"
                        : item.status === "failed"
                          ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/50"
                          : "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
                  }`}
                >
                  <span className="shrink-0 font-mono text-gray-500 dark:text-gray-400">{idx + 1}.</span>
                  {editingId === item.id ? (
                    <input
                      autoFocus
                      aria-label={`Edit queued message ${idx + 1}`}
                      value={item.content}
                      onChange={(e) => onEditContent(item.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === "Enter") { e.preventDefault(); onEdit(null); }
                        if (e.key === "Escape") onEdit(null);
                      }}
                      onBlur={() => onEdit(null)}
                      className="min-w-0 flex-1 rounded border border-indigo-300 bg-white px-1.5 py-1 text-base sm:text-xs dark:border-indigo-700 dark:bg-gray-800"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">{item.content}</span>
                  )}
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      item.status === "queued"
                        ? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                        : item.status === "sending"
                          ? "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300"
                          : item.status === "sent"
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300"
                            : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
                    }`}
                  >
                    {item.status}
                  </span>
                  {editable && (
                    <div className="flex shrink-0 items-center">
                      {item.status === "failed" && (
                        <button type="button" onClick={() => onRetry(item.id)} disabled={sending} aria-label={`Retry message ${idx + 1}`} title="Retry" className={iconBtn}>
                          <RotateCcw size={13} />
                        </button>
                      )}
                      <button type="button" onClick={() => onMove(item.id, -1)} disabled={idx === 0} aria-label={`Move message ${idx + 1} up`} title="Move up" className={iconBtn}>
                        <ChevronUp size={14} />
                      </button>
                      <button type="button" onClick={() => onMove(item.id, 1)} disabled={idx === queue.length - 1} aria-label={`Move message ${idx + 1} down`} title="Move down" className={iconBtn}>
                        <ChevronDown size={14} />
                      </button>
                      <button type="button" onClick={() => onEdit(item.id)} aria-label={`Edit message ${idx + 1}`} title="Edit" className={iconBtn}>
                        <Edit2 size={13} />
                      </button>
                      <button type="button" onClick={() => onRemove(item.id)} aria-label={`Remove message ${idx + 1}`} title="Remove" className={`${iconBtn} hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950`}>
                        <X size={14} />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <ComposerInput
          draft={draft}
          projectName={projectName}
          mentionOpen={mentionOpen}
          activeDescendant={mentionOpen ? `composer-mention-${activeIndex}` : undefined}
          onChange={onDraftChange}
          onSend={onSend}
          onQueue={onQueue}
          onMentionKey={(key) => {
            if (key === "ArrowDown") setActiveIndex((i) => (i + 1) % options.length);
            else if (key === "ArrowUp") setActiveIndex((i) => (i - 1 + options.length) % options.length);
            else if (key === "Escape") onDismissMention();
            else choose(options[activeIndex]);
          }}
        />

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onDraftChange(`${draft}${draft && !/\s$/.test(draft) ? " " : ""}@`)}
            title="Mention a teammate or file"
            aria-label="Mention a teammate or file"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 outline-none transition hover:bg-gray-100 hover:text-gray-800 focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          >
            <AtSign size={16} />
          </button>
          <span className="ml-auto hidden text-[11px] text-gray-500 md:block dark:text-gray-400">
            Enter to send · Shift+Enter new line · Alt+Enter queue
          </span>
          {queue.length > 0 && (
            <button
              type="button"
              onClick={onSendAll}
              disabled={sending || pendingCount === 0}
              className="ml-auto flex items-center gap-1 rounded-xl border border-[#e5e3eb] px-3 py-1.5 text-sm font-medium text-gray-700 outline-none transition hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-[#635bff]/40 disabled:cursor-not-allowed disabled:opacity-50 md:ml-0 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <Send size={14} /> Send queue ({pendingCount})
            </button>
          )}
          <button
            type="button"
            onClick={onSend}
            disabled={sending || !draft.trim()}
            aria-label="Send message"
            className={`${queue.length > 0 ? "" : "ml-auto md:ml-0"} flex h-9 w-9 items-center justify-center rounded-xl bg-[#635bff] text-white shadow-sm outline-none transition hover:bg-[#5346d8] focus-visible:ring-2 focus-visible:ring-[#635bff]/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 sm:h-8 sm:w-8 dark:focus-visible:ring-offset-gray-950`}
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </div>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

function ComposerInput({
  draft,
  projectName,
  mentionOpen,
  activeDescendant,
  onChange,
  onSend,
  onQueue,
  onMentionKey,
}: {
  draft: string;
  projectName: string;
  mentionOpen: boolean;
  activeDescendant?: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onQueue: () => void;
  onMentionKey: (key: "ArrowDown" | "ArrowUp" | "Enter" | "Escape") => void;
}) {
  // Re-measures on every draft change, so the box shrinks after sending and
  // grows when ✨ enhance replaces the text.
  const textareaRef = useAutoGrowRef([draft], 160);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceError, setEnhanceError] = useState("");

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
        setEnhanceError(error.error || "Enhancement failed");
        return;
      }
      const data = (await response.json()) as { enhanced?: string };
      if (data.enhanced) {
        setEnhanceError("");
        onChange(data.enhanced);
      }
    } catch (err) {
      setEnhanceError(err instanceof Error ? err.message : "Enhancement failed");
    } finally {
      setEnhancing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Never act while an IME is composing (CJK input): Enter confirms the
    // candidate, it must not send half-typed text.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (mentionOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Escape") {
        e.preventDefault();
        onMentionKey(e.key);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        onMentionKey("Enter");
        return;
      }
    }
    if (e.key !== "Enter") return;
    if (e.altKey) {
      e.preventDefault();
      onQueue();
      return;
    }
    if (e.shiftKey) return; // newline
    // On touch keyboards Return inserts a new line; the send button sends.
    const touch = typeof window !== "undefined" && window.matchMedia?.("(hover: none) and (pointer: coarse)").matches;
    if (touch) return;
    e.preventDefault();
    onSend();
  };

  return (
    <div className="rounded-2xl border border-[#e5e3eb] bg-white px-4 pb-2.5 pt-3 shadow-sm transition focus-within:border-[#a29ae8] focus-within:ring-2 focus-within:ring-[#e5e1ff] dark:border-gray-700 dark:bg-gray-900 dark:focus-within:border-indigo-400 dark:focus-within:ring-indigo-900">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            setEnhanceError("");
            onChange(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          rows={1}
          aria-label={`Message ${projectName}`}
          aria-autocomplete="list"
          aria-controls={mentionOpen ? "composer-mentions" : undefined}
          aria-expanded={mentionOpen}
          aria-activedescendant={activeDescendant}
          placeholder={`Message ${projectName}. Type @ to mention a teammate or file`}
          className="w-full resize-none bg-transparent px-0.5 text-base leading-6 text-gray-900 outline-none placeholder:text-gray-400 sm:text-[15px] dark:text-white dark:placeholder:text-gray-500"
          style={{ minHeight: "24px", maxHeight: "160px" }}
        />
        {draft.trim() && !enhancing && (
          <button
            type="button"
            onClick={handleEnhance}
            title="Enhance prompt with AI"
            aria-label="Enhance prompt with AI"
            className="shrink-0 rounded-lg p-1.5 text-gray-500 outline-none transition hover:bg-[#e5e1ff] hover:text-[#635bff] focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-gray-400 dark:hover:bg-indigo-900 dark:hover:text-indigo-300"
          >
            <Sparkles size={16} />
          </button>
        )}
        {enhancing && (
          <span role="status" aria-label="Enhancing prompt" className="shrink-0 p-1.5 text-[#635bff] dark:text-indigo-300">
            <Loader2 size={16} className="animate-spin" />
          </span>
        )}
      </div>
      {enhanceError && (
        <p role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">{enhanceError}</p>
      )}
    </div>
  );
}
