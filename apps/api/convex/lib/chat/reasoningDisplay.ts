/**
 * The model's reasoning as the chat may show it: behind a collapsed
 * "Reasoning" disclosure, with lines that echo the system prompt removed
 * (best effort), repeated lines dropped, and a length cap. Live transcripts
 * 2026-11-11: the panel held the whole raw monologue, quoting the persona,
 * "at most 6 tool calls", "reply with ONLY one JSON object", the grounding
 * rules and the earlier conversation, with the plan written twice.
 *
 * Pure: no Convex, Node or DOM APIs. Applies to every role's reply.
 */

/** Characters of reasoning shown at most; the rest is cut at a line break. */
export const REASONING_DISPLAY_MAX_CHARS = 1200;

const PROMPT_ECHO: RegExp[] = [
  /\b(?:system|my|the)\s+prompt\b/i,
  /\bmy\s+(?:instructions|persona|guidelines|rules)\b/i,
  /\b(?:the|these)\s+(?:instructions|guidelines|rules)\s+(?:say|tell|require|ask|state|mention)/i,
  /\b(?:my|the agent|this) persona\b|\brole prompt\b/i,
  /\blazy\s+senior\b/i,
  /\bat most\s+\d+\s+(?:repo\s+)?tool\s*calls?\b/i,
  /\btool[- ]?call(?:s)?\s+(?:protocol|format|budget|limit)\b/i,
  /\b(?:only|exactly)\s+one\s+json\s+object\b/i,
  /\breply with only\b/i,
  /\bgrounding rule\b/i,
  /\b(?:repo tools?|tool budget)\b.*\b(?:limit|budget|allowed|left)\b/i,
  /\bi(?:'m| am) (?:told|instructed|supposed) to\b/i,
  /\b(?:the )?(?:earlier|prior|previous) (?:conversation|turns?) (?:says?|shows?|was)\b/i,
];

/** A line that talks about the prompt, the tool protocol or the hidden context rather than the answer. */
export function isPromptEchoLine(line: string): boolean {
  return PROMPT_ECHO.some((re) => re.test(line));
}

/** Reasoning cleaned for display: prompt echoes and repeated lines out, capped. */
export function reasoningForDisplay(raw: string | null | undefined, max = REASONING_DISPLAY_MAX_CHARS): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of (raw ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (kept.length && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    if (isPromptEchoLine(trimmed)) continue;
    const key = trimmed.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(line.trimEnd());
  }
  const text = kept.join("\n").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastBreak = cut.lastIndexOf("\n");
  return `${(lastBreak > max * 0.5 ? cut.slice(0, lastBreak) : cut).trimEnd()}…`;
}
