/**
 * Reply quotes: a user message may quote an earlier message (agent or user)
 * like "reply" in a chat app. Pure helpers shared by the backend (routing +
 * prompt context) and the web UI (quote bar + bubble snippet).
 */

import { roleLabel } from "../roles";

/** Max characters of the quoted text that ride into the agent prompt. */
export const QUOTE_CONTEXT_MAX = 600;

/** Drop markdown syntax so a quote reads as plain text on one line. */
export function stripMarkdown(content: string): string {
  return (
    content
      // File attachments appended by the composer are context, not the message.
      .replace(/\n\n--- File: [^\n]+ ---\n[\s\S]*$/, "")
      // Option blocks the CTO emits for pickers.
      .replace(/\[options\][\s\S]*?(\[\/options\]|$)/gi, " ")
      .replace(/```[\w-]*\n?([\s\S]*?)```/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")
      .replace(/^\s*([-*_]\s*){3,}$/gm, " ")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/\|/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** One-line, markdown-free snippet of a message, cut at `max` chars. */
export function quoteSnippet(content: string, max = 140): string {
  const plain = stripMarkdown(content ?? "");
  if (plain.length <= max) return plain;
  return `${plain.slice(0, max - 1).trimEnd()}…`;
}

export type QuotedMessage = {
  authorType: "user" | "agent";
  agentId?: string;
  /** Role of the agent that wrote it (agent quotes only). */
  role?: string;
  content: string;
  /** The author is an enabled member of the project team. */
  inTeam?: boolean;
};

/**
 * The agent that should answer a reply to `quote`, or null to route as
 * usual. A quoted agent (the CTO included since O3: it is no longer the
 * default speaker) answers when the user @mentioned nobody; the user's own
 * messages and System lines route as usual.
 */
export function quotedResponderId(quote: QuotedMessage | null | undefined, userMentionCount: number): string | null {
  if (!quote || quote.authorType !== "agent" || !quote.agentId) return null;
  if (userMentionCount > 0) return null;
  if (quote.inTeam === false) return null;
  return quote.agentId;
}

/** Prompt line telling the agent what "this"/"ini" refers to. */
export function quoteContextLine(quote: QuotedMessage): string {
  const text = quoteSnippet(quote.content, QUOTE_CONTEXT_MAX);
  if (quote.authorType === "user") return `The user is replying to their own earlier message: "${text}"`;
  return `The user is replying to ${roleLabel(quote.role)}'s message: "${text}"`;
}
