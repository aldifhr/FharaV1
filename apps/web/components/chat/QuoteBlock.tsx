"use client";

import { X } from "lucide-react";
import { quoteSnippet } from "@/api/convex/lib/chat/quote";
import { roleLabel } from "@/lib/agentRoles";

/** What the composer and a bubble need to show a quoted message. */
export type ChatQuote = { messageId: string; author: string; snippet: string };

/** Quote for `message`: "You" for the user's own, else the agent's role. */
export function quoteOf(message: any, agents: any[] | undefined): ChatQuote {
  const author =
    message.authorType === "user"
      ? "You"
      : roleLabel((agents ?? []).find((a: any) => a._id === message.agentId)?.role);
  return { messageId: String(message._id), author, snippet: quoteSnippet(message.content ?? "") };
}

/** Slim bar above the composer while replying: role, one-line snippet, ×. */
export function QuoteBar({ quote, onCancel }: { quote: ChatQuote; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-2.5">
      <div className="min-w-0 flex-1 border-l-2 border-line-strong pl-2.5 text-[13px] leading-5">
        <span className="font-medium text-ink-2">Replying to {quote.author}</span>
        <span className="block truncate text-ink-3">{quote.snippet || "Message"}</span>
      </div>
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel reply"
        title="Cancel reply (Esc)"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-3 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <X size={14} />
      </button>
    </div>
  );
}

/** Small quote above a user bubble's text; clicking jumps to the original. */
export function QuotedSnippet({ quote, onJump }: { quote: ChatQuote | null; onJump?: (messageId: string) => void }) {
  const body = (
    <>
      <span className="block font-medium text-ink-2">{quote?.author ?? "Earlier message"}</span>
      <span className="block truncate text-ink-3">{quote ? quote.snippet || "Message" : "Not in the loaded history"}</span>
    </>
  );
  const cls = "mb-1.5 block w-full min-w-0 max-w-full border-l-2 border-line-strong pl-2.5 text-left text-[12.5px] leading-5";
  if (!quote || !onJump) return <div className={cls}>{body}</div>;
  return (
    <button
      type="button"
      onClick={() => onJump(quote.messageId)}
      title="Jump to message"
      className={`${cls} rounded-r-md outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40`}
    >
      {body}
    </button>
  );
}
