"use client";

import { useEffect, useRef, useState } from "react";
import {
  AtSign,
  Bold,
  ChevronDown,
  ChevronUp,
  Code,
  Edit2,
  FileText,
  Italic,
  List,
  Loader2,
  Mic,
  Paperclip,
  RotateCcw,
  SendHorizontal,
  Shield,
  SquareSlash,
  Sparkles,
  SquareCode,
  Type,
  X,
} from "lucide-react";
import { agentName, roleLabel } from "@/lib/agentRoles";
import InitialAvatar from "../InitialAvatar";
import { QuoteBar, type ChatQuote } from "./QuoteBlock";
import { useToast } from "../Toasts";
import { useAutoGrowRef, type QueuedMessage } from "./useChatQueue";
import { useMediaQuery } from "@/lib/useMediaQuery";
import {
  PERMISSION_MODES,
  PERMISSION_MODE_HINTS,
  PERMISSION_MODE_LABELS,
  type PermissionMode,
} from "@/api/convex/lib/permissionModes";
import SlashMenu from "./SlashMenu";
import { ATTACH_MAX_BYTES, COMPOSER_MAX_CHARS, composeMessage, formatBytes, looksBinary, pasteAction, pastedName, utf8Bytes, type TextAttachment } from "@/lib/composerPaste";
import { committedUsage, completeSlash, filterSlashEntries, runsOnEnter, slashMenuEntries, type SlashMenuEntry } from "@/lib/slashMenu";

type MentionAgent = { _id: string; name: string; role: string; avatarParams?: unknown };
type MentionOption = { kind: "agent"; agent: MentionAgent } | { kind: "file"; path: string };

/** Project-chat default: the registry's project builtins (ChatPanel adds team skills). */
const DEFAULT_SLASH_ENTRIES: SlashMenuEntry[] = slashMenuEntries("project", []);

const tool =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-3 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40";
const rowBtn =
  "flex h-7 w-7 items-center justify-center rounded-md text-ink-3 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 disabled:cursor-not-allowed disabled:opacity-30";

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
};

function speechCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return ((w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | undefined) ?? null;
}

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
  targets,
  targetId,
  onTargetChange,
  permissionMode,
  onPermissionModeChange,
  quote = null,
  onCancelQuote,
  placeholder,
  onKeyIntercept,
  slashCommands = DEFAULT_SLASH_ENTRIES,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  /** `content` is the whole message when text attachments ride along; resolve false to keep them. */
  onSend: (content?: string) => unknown;
  onQueue: (content?: string) => unknown;
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
  /** Teammates the message can be pinned to; null = the team (the server routes it, O4). */
  targets: MentionAgent[];
  targetId: string | null;
  onTargetChange: (agentId: string | null) => void;
  /** Plan 020: permission mode for tasks this composer dispatches. */
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  /** Message being replied to (quote bar above the input); Esc or × cancels. */
  quote?: ChatQuote | null;
  onCancelQuote?: () => void;
  /** Overrides the default "Message the team" placeholder (decisions tray). */
  placeholder?: string;
  /** Runs first on Enter / Escape when no picker is open; true = handled. */
  onKeyIntercept?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** "/" menu rows from the shared registry (lib/slashMenu `slashMenuEntries`). */
  slashCommands?: SlashMenuEntry[];
}) {
  const toast = useToast();
  const textareaRef = useAutoGrowRef([draft], 200);
  const fileRef = useRef<HTMLInputElement>(null);
  const [formatOpen, setFormatOpen] = useState(false);
  const [targetOpen, setTargetOpen] = useState(false);
  const targetRef = useRef<HTMLDivElement>(null);
  const [modeOpen, setModeOpen] = useState(false);
  const modeRef = useRef<HTMLDivElement>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceError, setEnhanceError] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const narrow = useMediaQuery("(max-width: 639px)", false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [attachments, setAttachments] = useState<TextAttachment[]>([]);
  const attachSeq = useRef(0);
  const canSend = Boolean(draft.trim()) || attachments.length > 0;

  const addAttachment = (name: string, text: string) => {
    attachSeq.current += 1;
    setAttachments((list) => [...list, { id: `att-${attachSeq.current}`, name, text, bytes: utf8Bytes(text) }]);
  };
  // With attachments the parent gets the whole message; they clear once it's taken.
  const submit = async (queue: boolean) => {
    const handler = queue ? onQueue : onSend;
    if (!attachments.length) return void handler();
    const sent = attachments;
    const ok = await handler(composeMessage(draftRef.current, sent));
    if (ok !== false) setAttachments((list) => list.filter((a) => !sent.includes(a)));
  };
  const send = () => void submit(false);

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const el = e.currentTarget;
    const action = pasteAction(text, draft.length, Math.abs((el.selectionEnd ?? 0) - (el.selectionStart ?? 0)));
    if (action === "inline") return;
    e.preventDefault();
    if (action === "too_large") {
      toast("error", "Paste too large", `Paste up to ${Math.round(ATTACH_MAX_BYTES / 1000)} KB at a time.`);
      return;
    }
    addAttachment(pastedName(attachments), text);
  };

  // Reply: focus the input so the user can type right away.
  const quoteId = quote?.messageId;
  useEffect(() => {
    if (quoteId) textareaRef.current?.focus();
  }, [quoteId, textareaRef]);

  // Feature-detect after mount (SSR has no window): no mic button without the API.
  useEffect(() => setSpeechSupported(speechCtor() !== null), []);
  useEffect(() => () => recognitionRef.current?.stop(), []);

  useEffect(() => {
    if (!targetOpen) return;
    const onDown = (e: MouseEvent) => !targetRef.current?.contains(e.target as Node) && setTargetOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setTargetOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [targetOpen]);

  useEffect(() => {
    if (!modeOpen) return;
    const onDown = (e: MouseEvent) => !modeRef.current?.contains(e.target as Node) && setModeOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setModeOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [modeOpen]);

  // Slash menu (Paradev C2): the draft starts with "/word"; Esc hides it for
  // this exact draft only, so the next keystroke can bring it back.
  const [slashDismissedFor, setSlashDismissedFor] = useState<string | null>(null);
  const slashState = filterSlashEntries(draft, slashCommands);
  const slashOptions = slashState?.matches ?? [];
  const slashOpen = slashOptions.length > 0 && slashDismissedFor !== draft;
  const usage = committedUsage(draft, slashCommands);

  const mentionOptions: MentionOption[] = [
    ...agentResults.map((agent) => ({ kind: "agent" as const, agent })),
    ...mentionResults.map((path) => ({ kind: "file" as const, path })),
  ];
  const mentionOpen = !slashOpen && mention !== null && mentionOptions.length > 0;
  const listLength = slashOpen ? slashOptions.length : mentionOptions.length;
  useEffect(() => setActiveIndex(0), [mention, listLength, slashOpen, slashState?.query]);

  const chooseMention = (option: MentionOption | undefined) => {
    if (!option) return;
    if (option.kind === "agent") onInsertAgent(option.agent);
    else onInsertMention(option.path);
  };
  const chooseSlash = (command: SlashMenuEntry | undefined) => {
    if (!command || command.disabled) return;
    const next = completeSlash(draft, command.name);
    onDraftChange(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      // Caret right after "/name " so the argument goes there.
      const caret = command.name.length + 2;
      el.setSelectionRange(caret, caret);
    });
  };

  const insertAtCursor = (before: string, after = "", placeholder = "") => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    const selected = draft.slice(start, end) || placeholder;
    const next = draft.slice(0, start) + before + selected + after + draft.slice(end);
    onDraftChange(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const caret = start + before.length;
      el.setSelectionRange(caret, caret + selected.length);
    });
  };

  const appendToken = (token: string) => {
    onDraftChange(`${draft}${draft && !/\s$/.test(draft) ? " " : ""}${token}`);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const attachFile = async (file: File) => {
    if (file.size > ATTACH_MAX_BYTES) {
      toast("error", "File too large", `Attach text files up to ${Math.round(ATTACH_MAX_BYTES / 1000)} KB.`);
      return;
    }
    const text = await file.text();
    // Binary files decode with replacement characters; refuse them.
    if (looksBinary(text)) {
      toast("error", "Only text files can be attached", file.name);
      return;
    }
    addAttachment(file.name, text);
  };

  const toggleMic = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    const base = draftRef.current ? `${draftRef.current.replace(/\s+$/, "")} ` : "";
    rec.onresult = (event) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i += 1) transcript += event.results[i][0].transcript;
      onDraftChange(base + transcript);
    };
    rec.onerror = (event) => {
      if (event.error !== "aborted" && event.error !== "no-speech") toast("error", "Voice input stopped", event.error);
    };
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
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
        const body = await response.json().catch(() => ({ error: "Enhancement failed" }));
        setEnhanceError(body.error || "Enhancement failed");
        return;
      }
      const data = (await response.json()) as { enhanced?: string };
      if (data.enhanced) {
        setEnhanceError("");
        onDraftChange(data.enhanced);
      }
    } catch (err) {
      setEnhanceError(err instanceof Error ? err.message : "Enhancement failed");
    } finally {
      setEnhancing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Never act while an IME is composing (CJK input).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (slashOpen || mentionOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((i) => (i + step + listLength) % listLength);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Closes the menu and keeps the draft.
        if (mentionOpen) onDismissMention();
        else setSlashDismissedFor(draft);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey && !e.altKey) || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        if (slashOpen) {
          const entry = slashOptions[activeIndex];
          // Enter on an exact no-argument command ("/push") runs it.
          if (e.key === "Enter" && runsOnEnter(slashState, entry)) send();
          else chooseSlash(entry);
        } else chooseMention(mentionOptions[activeIndex]);
        return;
      }
    }
    if (!slashOpen && !mentionOpen && !attachments.length && onKeyIntercept?.(e)) return;
    if (e.key === "Escape" && quote && onCancelQuote) {
      e.preventDefault();
      onCancelQuote();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === "b" || key === "i" || key === "e") {
        e.preventDefault();
        if (key === "b") insertAtCursor("**", "**");
        else if (key === "i") insertAtCursor("_", "_");
        else insertAtCursor("`", "`");
        return;
      }
    }
    if (e.key !== "Enter") return;
    if (e.altKey) {
      e.preventDefault();
      void submit(true);
      return;
    }
    if (e.shiftKey) return;
    // On touch keyboards Return inserts a new line; the send button sends.
    const touch = typeof window !== "undefined" && window.matchMedia?.("(hover: none) and (pointer: coarse)").matches;
    if (touch) return;
    e.preventDefault();
    send();
  };

  const target = targets.find((a) => a._id === targetId) ?? null;
  const pendingCount = queue.filter((m) => m.status === "queued" || m.status === "failed").length;
  const popover =
    "absolute bottom-full left-0 z-30 mb-2 max-h-64 w-full overflow-y-auto rounded-xl border border-line bg-panel py-1 shadow-[0_12px_32px_-12px_rgba(20,20,40,0.3)]";

  return (
    <div className="shrink-0 bg-panel px-3 pb-[max(0.875rem,env(safe-area-inset-bottom))] pt-1 sm:px-8 lg:px-10">
      <div className="relative flex flex-col gap-2">
        {slashOpen && (
          <SlashMenu
            id="composer-slash"
            entries={slashOptions}
            activeIndex={activeIndex}
            onHover={setActiveIndex}
            onPick={chooseSlash}
            className={popover.replace("max-h-64", "max-h-[min(24rem,50vh)]")}
          />
        )}
        {mentionOpen && (
          <ul id="composer-mentions" role="listbox" aria-label="Mention a teammate or file" className={popover}>
            {mentionOptions.map((option, index) => {
              const active = index === activeIndex;
              const heading =
                index === 0 && option.kind === "agent" ? "Team" : option.kind === "file" && index === agentResults.length ? "Files" : null;
              return (
                <li key={option.kind === "agent" ? option.agent._id : option.path} id={`composer-mention-${index}`} role="option" aria-selected={active}>
                  {heading && <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">{heading}</p>}
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => chooseMention(option)}
                    className={`flex w-full items-center gap-2.5 truncate px-3 py-2 text-left text-[14px] ${active ? "bg-hover" : ""}`}
                  >
                    {option.kind === "agent" ? (
                      <>
                        <InitialAvatar agent avatarParams={option.agent.avatarParams} name={roleLabel(option.agent.role)} size={20} />
                        <span className="font-medium text-ink">@{roleLabel(option.agent.role)}</span>
                      </>
                    ) : (
                      <span className="truncate font-mono text-[12.5px] text-ink-2">@{option.path}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {queue.length > 0 && (
          <ul className="space-y-1" aria-label="Queued messages">
            {queue.map((item, idx) => {
              const editable = item.status === "queued" || item.status === "failed";
              const tone =
                item.status === "sending"
                  ? "text-sky-600 dark:text-sky-400"
                  : item.status === "sent"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : item.status === "failed"
                      ? "text-red-600 dark:text-red-400"
                      : "text-ink-3";
              return (
                <li key={item.id} className="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-2.5 py-1 text-[13px]">
                  <span className="shrink-0 tabular-nums text-ink-3">{idx + 1}.</span>
                  {editingId === item.id ? (
                    <input
                      autoFocus
                      aria-label={`Edit queued message ${idx + 1}`}
                      value={item.content}
                      onChange={(e) => onEditContent(item.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === "Enter" || e.key === "Escape") {
                          e.preventDefault();
                          onEdit(null);
                        }
                      }}
                      onBlur={() => onEdit(null)}
                      className="min-w-0 flex-1 rounded border border-line bg-panel px-1.5 py-0.5 text-base text-ink outline-none sm:text-[13px]"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-ink">{item.content}</span>
                  )}
                  <span className={`shrink-0 text-[12px] ${tone}`}>{item.status}</span>
                  {editable && (
                    <span className="flex shrink-0 items-center">
                      {item.status === "failed" && (
                        <button type="button" onClick={() => onRetry(item.id)} disabled={sending} aria-label={`Retry message ${idx + 1}`} className={rowBtn}>
                          <RotateCcw size={13} />
                        </button>
                      )}
                      <button type="button" onClick={() => onMove(item.id, -1)} disabled={idx === 0} aria-label={`Move message ${idx + 1} up`} className={rowBtn}>
                        <ChevronUp size={14} />
                      </button>
                      <button type="button" onClick={() => onMove(item.id, 1)} disabled={idx === queue.length - 1} aria-label={`Move message ${idx + 1} down`} className={rowBtn}>
                        <ChevronDown size={14} />
                      </button>
                      <button type="button" onClick={() => onEdit(item.id)} aria-label={`Edit message ${idx + 1}`} className={rowBtn}>
                        <Edit2 size={13} />
                      </button>
                      <button type="button" onClick={() => onRemove(item.id)} aria-label={`Remove message ${idx + 1}`} className={`${rowBtn} hover:text-red-600`}>
                        <X size={14} />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="rounded-2xl border border-line-strong bg-panel shadow-[0_1px_2px_rgba(20,20,40,0.04)] transition focus-within:border-ink/30 focus-within:ring-4 focus-within:ring-ink/30">
          {quote && onCancelQuote && <QuoteBar quote={quote} onCancel={onCancelQuote} />}
          {formatOpen && (
            <div className="flex items-center gap-0.5 border-b border-line px-2 py-1" role="toolbar" aria-label="Formatting">
              <button type="button" className={rowBtn} aria-label="Bold (⌘B)" title="Bold (⌘B)" onClick={() => insertAtCursor("**", "**", "bold")}>
                <Bold size={14} />
              </button>
              <button type="button" className={rowBtn} aria-label="Italic (⌘I)" title="Italic (⌘I)" onClick={() => insertAtCursor("_", "_", "italic")}>
                <Italic size={14} />
              </button>
              <button type="button" className={rowBtn} aria-label="Inline code (⌘E)" title="Inline code (⌘E)" onClick={() => insertAtCursor("`", "`", "code")}>
                <Code size={14} />
              </button>
              <button type="button" className={rowBtn} aria-label="Code block" title="Code block" onClick={() => insertAtCursor("\n```\n", "\n```\n", "")}>
                <SquareCode size={14} />
              </button>
              <button type="button" className={rowBtn} aria-label="Bulleted list" title="Bulleted list" onClick={() => insertAtCursor("\n- ", "", "item")}>
                <List size={14} />
              </button>
            </div>
          )}
          {attachments.length > 0 && (
            <ul aria-label="Attachments" className="divide-y divide-line border-b border-line">
              {attachments.map((a) => (
                <li key={a.id} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
                  <FileText size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{a.name}</span>
                  <span className="shrink-0 tabular-nums text-[12px] text-ink-3">{formatBytes(a.bytes)}</span>
                  <button type="button" onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))} aria-label={`Remove ${a.name}`} className={rowBtn}>
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {usage && (
            <p id="composer-slash-usage" className="truncate px-4 pt-2 font-mono text-[12px] text-ink-3">
              {usage}
            </p>
          )}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              setEnhanceError("");
              onDraftChange(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            maxLength={COMPOSER_MAX_CHARS}
            rows={1}
            aria-label={`Message ${projectName}`}
            aria-autocomplete="list"
            aria-controls={slashOpen ? "composer-slash" : mentionOpen ? "composer-mentions" : undefined}
            aria-expanded={slashOpen || mentionOpen}
            aria-activedescendant={slashOpen ? `composer-slash-${activeIndex}` : mentionOpen ? `composer-mention-${activeIndex}` : undefined}
            aria-describedby={usage ? "composer-slash-usage" : undefined}
            placeholder={placeholder ?? (narrow ? "Message the team" : "Message the team, or type / for a command")}
            className="block w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-base leading-6 text-ink outline-none placeholder:text-ink-3 sm:text-[15px]"
            style={{ minHeight: 48, maxHeight: 200 }}
          />
          <div className="flex items-center gap-0.5 px-2 pb-2">
            <button type="button" className={`${tool} ${formatOpen ? "bg-hover text-ink" : ""}`} aria-label="Formatting" aria-pressed={formatOpen} title="Formatting" onClick={() => setFormatOpen((o) => !o)}>
              <Type size={16} />
            </button>
            <button type="button" className={tool} aria-label="Attach a text file" title="Attach a text file" onClick={() => fileRef.current?.click()}>
              <Paperclip size={16} />
            </button>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void attachFile(file);
              }}
            />
            <button type="button" className={tool} aria-label="Mention a teammate or file" title="Mention" onClick={() => appendToken("@")}>
              <AtSign size={16} />
            </button>
            <button type="button" className={`${tool} max-sm:hidden`} aria-label="Commands" title="Commands" onClick={() => (draft ? appendToken("/") : onDraftChange("/"))}>
              <SquareSlash size={16} />
            </button>
            {speechSupported && (
              <button
                type="button"
                className={`${tool} ${listening ? "bg-red-50 text-red-600 hover:bg-red-50 hover:text-red-600 dark:bg-red-950/40" : ""}`}
                aria-label={listening ? "Stop voice input" : "Voice input"}
                aria-pressed={listening}
                title={listening ? "Stop voice input" : "Voice input"}
                onClick={toggleMic}
              >
                <Mic size={16} />
              </button>
            )}
            {draft.trim() && (
              <button type="button" className={`${tool} max-sm:hidden`} aria-label="Enhance prompt with AI" title="Enhance prompt with AI" disabled={enhancing} onClick={() => void handleEnhance()}>
                {enhancing ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
              </button>
            )}
            {targets.length > 0 && (
              <div ref={targetRef} className="relative ml-1 min-w-0">
                <button
                  type="button"
                  onClick={() => setTargetOpen((o) => !o)}
                  aria-haspopup="listbox"
                  aria-expanded={targetOpen}
                  aria-label={target ? `Only ${roleLabel(target.role)} answers` : "Choose a teammate to answer"}
                  className="flex h-8 min-w-0 items-center gap-1.5 rounded-lg bg-hover px-2 text-[13.5px] text-ink outline-none transition hover:bg-line focus-visible:ring-2 focus-visible:ring-ink/30"
                >
                  {target && <InitialAvatar agent avatarParams={target.avatarParams} name={roleLabel(target.role)} size={18} />}
                  <span className="truncate">{target ? roleLabel(target.role) : "Team"}</span>
                  <ChevronDown size={13} className="shrink-0 text-ink-3" />
                </button>
                {targetOpen && (
                  <ul role="listbox" aria-label="Who answers" className="absolute bottom-full left-0 z-30 mb-2 max-h-72 w-56 overflow-y-auto rounded-xl border border-line bg-panel py-1 shadow-[0_12px_32px_-12px_rgba(20,20,40,0.3)]">
                    {[{ _id: null, role: "team" } as any, ...targets].map((agent: any) => (
                      <li key={agent._id ?? "team"} role="option" aria-selected={agent._id === targetId}>
                        <button
                          type="button"
                          onClick={() => {
                            onTargetChange(agent._id);
                            setTargetOpen(false);
                          }}
                          className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[14px] text-ink hover:bg-hover ${agent._id === targetId ? "font-medium" : ""}`}
                        >
                          <InitialAvatar agent={Boolean(agent._id)} avatarParams={agent.avatarParams} name={agent._id ? agentName(agent) : "Team"} size={20} />
                          <span className="flex-1 truncate">{agent._id ? agentName(agent) : "Team"}</span>
                          {agent._id === targetId && <span className="text-[12px] text-ink">current</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <span className="ml-auto hidden pr-2 text-[12.5px] text-ink-3 md:block">Enter to send</span>
            {queue.length > 0 && (
              <button
                type="button"
                onClick={onSendAll}
                disabled={sending || pendingCount === 0}
                className="ml-auto mr-1.5 h-8 rounded-lg border border-line px-2.5 text-[13px] text-ink outline-none hover:bg-hover disabled:opacity-50 md:ml-0"
              >
                Send queue ({pendingCount})
              </button>
            )}
            {permissionMode && onPermissionModeChange && (
              <div ref={modeRef} className={`relative ${queue.length > 0 ? "" : "ml-auto md:ml-0"} mr-1 shrink-0`}>
                <button
                  type="button"
                  onClick={() => setModeOpen((o) => !o)}
                  aria-haspopup="listbox"
                  aria-expanded={modeOpen}
                  aria-label={`Permission mode: ${PERMISSION_MODE_LABELS[permissionMode]}`}
                  title={PERMISSION_MODE_HINTS[permissionMode]}
                  className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
                >
                  <Shield size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
                  <span className="max-sm:hidden">{PERMISSION_MODE_LABELS[permissionMode]}</span>
                  <ChevronDown size={13} className="shrink-0 text-ink-3" />
                </button>
                {modeOpen && (
                  <ul role="listbox" aria-label="Permission mode" className="absolute bottom-full right-0 z-30 mb-2 w-64 overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-[0_12px_32px_-12px_rgba(20,20,40,0.3)]">
                    {PERMISSION_MODES.map((mode) => (
                      <li key={mode} role="option" aria-selected={mode === permissionMode}>
                        <button
                          type="button"
                          onClick={() => {
                            onPermissionModeChange(mode);
                            setModeOpen(false);
                          }}
                          className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-hover"
                        >
                          <span className={`text-[13.5px] text-ink ${mode === permissionMode ? "font-medium" : ""}`}>{PERMISSION_MODE_LABELS[mode]}</span>
                          <span className="text-[12px] text-ink-3">{PERMISSION_MODE_HINTS[mode]}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={send}
              disabled={sending || !canSend}
              aria-label="Send message"
              className={`${queue.length > 0 || (permissionMode && onPermissionModeChange) ? "" : "ml-auto md:ml-0"} flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ink text-canvas shadow-sm outline-none transition hover:bg-ink/85 focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {sending ? <Loader2 size={16} className="animate-spin" /> : <SendHorizontal size={16} />}
            </button>
          </div>
        </div>
        {(error || enhanceError) && (
          <p role="alert" className="px-1 text-[13px] text-red-600 dark:text-red-400">
            {error || enhanceError}
          </p>
        )}
      </div>
    </div>
  );
}
