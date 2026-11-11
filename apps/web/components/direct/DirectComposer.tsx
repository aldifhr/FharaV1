"use client";

import { useEffect, useRef, useState } from "react";
import { SendHorizontal, Square } from "lucide-react";
import SlashMenu from "@/components/chat/SlashMenu";
import { committedUsage, completeSlash, filterSlashEntries, runsOnEnter, slashMenuEntries, type SlashMenuEntry } from "@/lib/slashMenu";

/** The direct composer's "/" rows: the registry's direct-scope builtins (`/goal`). */
const DIRECT_SLASH: SlashMenuEntry[] = slashMenuEntries("direct", []);
const EFFORTS = ["low", "medium", "high"] as const;
const ICON_BUTTON =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-field outline-none transition focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40";

/**
 * Direct-thread composer. Enter sends (typing while the agent runs steers
 * the turn; an open card is declined with the text). Stop replaces Send while
 * the agent runs and nothing is typed. The "/" menu offers the registry's
 * direct commands; `/goal …` goes to the server like any message.
 */
export default function DirectComposer({
  running,
  closed,
  effort,
  onSend,
  onStop,
  onEffort,
}: {
  running: boolean;
  closed: boolean;
  effort: string | null;
  /** Resolves false to keep the draft (the send failed). */
  onSend: (text: string) => Promise<boolean>;
  onStop: () => Promise<unknown>;
  onEffort: (effort: string | null) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const slash = filterSlashEntries(draft, DIRECT_SLASH);
  const options = slash?.matches ?? [];
  const slashOpen = options.length > 0 && dismissedFor !== draft;
  const usage = committedUsage(draft, DIRECT_SLASH);
  useEffect(() => setActive(0), [slash?.query, slashOpen]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || closed) return;
    setSending(true);
    try {
      if (await onSend(text)) setDraft("");
    } finally {
      setSending(false);
    }
  };
  const stop = async () => {
    setStopping(true);
    try {
      await onStop();
    } finally {
      setStopping(false);
    }
  };
  const pick = (entry: SlashMenuEntry | undefined) => {
    if (!entry) return;
    setDraft(completeSlash(draft, entry.name));
    ref.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (slashOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedFor(draft);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        if (e.key === "Enter" && runsOnEnter(slash, options[active])) void send();
        else pick(options[active]);
        return;
      }
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    const touch = typeof window !== "undefined" && window.matchMedia?.("(hover: none) and (pointer: coarse)").matches;
    if (touch) return;
    e.preventDefault();
    void send();
  };

  const showStop = running && !draft.trim();
  const placeholder = closed ? "This thread is closed." : running ? "Steer the agent, or type /goal" : "Message the agent, or type /goal";
  return (
    <div className="shrink-0 border-t border-line bg-panel px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
      <div className="relative">
        {slashOpen && (
          <SlashMenu
            id="direct-slash"
            entries={options}
            activeIndex={active}
            onHover={setActive}
            onPick={pick}
            className="absolute bottom-full left-0 z-30 mb-2 max-h-64 w-full overflow-y-auto rounded-xl border border-line bg-panel py-1 shadow-sm"
          />
        )}
        <div className="flex items-end gap-2 rounded-xl border border-line bg-panel px-2 py-1.5 focus-within:border-ink-3">
          <textarea
            ref={ref}
            value={draft}
            rows={1}
            disabled={closed}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label="Message the direct thread"
            aria-controls={slashOpen ? "direct-slash" : undefined}
            aria-expanded={slashOpen}
            aria-activedescendant={slashOpen ? `direct-slash-${active}` : undefined}
            className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-1.5 py-2 text-[14px] text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"
          />
          {showStop ? (
            <button type="button" onClick={() => void stop()} disabled={stopping} title="Stop the agent" aria-label="Stop the agent" className={`${ICON_BUTTON} border border-line text-ink hover:bg-hover`}>
              <Square size={14} />
            </button>
          ) : (
            <button type="button" onClick={() => void send()} disabled={!draft.trim() || sending || closed} title="Send" aria-label="Send" className={`${ICON_BUTTON} bg-ink text-canvas hover:bg-ink/85`}>
              <SendHorizontal size={15} />
            </button>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-3 px-1 text-[12px] text-ink-3">
        {usage ? <span className="truncate font-mono">{usage}</span> : <span className="truncate">{running ? "The agent is working. Enter steers it." : "Enter sends · Shift+Enter for a new line"}</span>}
        <label className="ml-auto flex shrink-0 items-center gap-1.5">
          Effort
          <select
            value={effort ?? ""}
            disabled={closed}
            onChange={(e) => void onEffort(e.target.value || null)}
            className="rounded-field border border-line bg-panel px-1.5 py-0.5 text-[12px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
          >
            <option value="">Default</option>
            {effort && !(EFFORTS as readonly string[]).includes(effort) && <option value={effort}>{effort}</option>}
            {EFFORTS.map((value) => (
              <option key={value} value={value}>
                {value[0].toUpperCase() + value.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
