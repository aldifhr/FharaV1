/**
 * Paradev C2: the pure half of the composer's "/" menu (plan
 * audit/paradev-plan-2026-11-11.md, P-C). Ranking, sorting and suppression
 * come from the shared registry (apps/api/convex/lib/slashCommands.ts, whose
 * core is copied from superset-sh/superset, MIT, see THIRD_PARTY_NOTICES.md);
 * this file only decides what the draft asks for. No React here so the web
 * unit tests can import it.
 */
import {
  builtinCommandsForScope,
  findBuiltinSlash,
  getCommandMatchRank,
  parseSlash,
  shouldSuppressSlashMenuForCommittedCommand,
  skillSlashEntry,
  sortSlashCommandMatches,
  type SlashCommand,
  type SlashCommandScope,
} from "@/api/convex/lib/slashCommands";

/** A menu row. A disabled row is listed but cannot be picked. */
export type SlashMenuEntry = SlashCommand & { disabled?: boolean; disabledNote?: string };

export interface SlashMenuState {
  /** The command word being typed, lower-cased, without "/" ("re"). */
  query: string;
  /** True when something follows the word ("/re fix the bug"). */
  hasRest: boolean;
  /** Ranked rows: builtins ("Commands") first, then skills. */
  matches: SlashMenuEntry[];
}

const LEADING_SLASH = /^\/([\w-]*)(\s[\s\S]*)?$/;

/**
 * What the "/" menu shows for a draft, or null when it stays closed.
 *
 * - Opens while the draft starts with "/word" (also when text already follows,
 *   so typing "/" in front of a message works).
 * - Once a command that takes arguments is followed by a space it hides
 *   (`shouldSuppressSlashMenuForCommittedCommand`).
 * - "/" alone lists everything.
 */
export function filterSlashEntries(draft: string, entries: readonly SlashMenuEntry[]): SlashMenuState | null {
  const m = LEADING_SLASH.exec(draft);
  if (!m) return null;
  const query = m[1].toLowerCase();
  const hasRest = m[2] !== undefined;
  if (hasRest && query === "") return null;
  if (hasRest && shouldSuppressSlashMenuForCommittedCommand(query, entries as SlashMenuEntry[])) return null;
  const ranked: Array<{ command: SlashMenuEntry; rank: number }> = [];
  for (const command of entries) {
    const rank = getCommandMatchRank(command, query);
    if (rank !== null) ranked.push({ command, rank });
  }
  if (ranked.length === 0) return null;
  return { query, hasRest, matches: sortSlashCommandMatches(ranked) };
}

/**
 * Replace the leading "/word" with "/name " and keep whatever followed it
 * ("/re fix it" + research → "/research fix it").
 */
export function completeSlash(draft: string, name: string): string {
  const m = LEADING_SLASH.exec(draft);
  const rest = m?.[2]?.replace(/^\s+/, "") ?? "";
  return `/${name} ${rest}`;
}

/**
 * True when Enter should run the draft instead of completing it: the typed
 * word is exactly a command that takes no arguments ("/push").
 */
export function runsOnEnter(state: SlashMenuState | null, entry: SlashMenuEntry | undefined): boolean {
  if (!state || !entry || entry.disabled) return false;
  return entry.entryKind === "command" && entry.argumentHint.trim() === "" && entry.name.toLowerCase() === state.query;
}

/**
 * The rows a chat offers: its scope's builtins, then the given skills
 * (deduplicated by name, skipping any that shadow a builtin). Since Paradev
 * C3 a skill row is callable: "/<skill> [request]" sends the message with
 * `invokedSkills` (see skillInvocation).
 */
export function slashMenuEntries(
  scope: SlashCommandScope,
  skills: ReadonlyArray<{ name: string; description?: string | null }>,
  opts: { attached?: boolean } = {}
): SlashMenuEntry[] {
  const builtins: SlashMenuEntry[] = builtinCommandsForScope(scope, opts);
  const taken = new Set(builtins.map((b) => b.name.toLowerCase()));
  const out: SlashMenuEntry[] = [...builtins];
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    if (!key || taken.has(key)) continue;
    taken.add(key);
    out.push(skillSlashEntry(skill));
  }
  return out;
}

/** "/task <what to do>" for the usage line shown once a command is committed. */
export function committedUsage(draft: string, entries: readonly SlashMenuEntry[]): string | null {
  const m = /^\/([\w-]+)\s+$/.exec(draft);
  if (!m) return null;
  const entry = entries.find((e) => e.name.toLowerCase() === m[1].toLowerCase() && !e.disabled);
  if (!entry || !entry.argumentHint.trim()) return null;
  return `/${entry.name} ${entry.argumentHint}`;
}

/** Skills assigned to any of the given agents (from `api.skills.list` rows). */
export function skillsUsedBy<T extends { name: string; usedBy?: ReadonlyArray<{ _id: unknown }> }>(
  skills: readonly T[] | undefined,
  agentIds: ReadonlyArray<unknown>
): T[] {
  if (!skills?.length || !agentIds.length) return [];
  const ids = new Set(agentIds.map(String));
  return skills.filter((s) => (s.usedBy ?? []).some((a) => ids.has(String(a._id))));
}

/**
 * Paradev C3: "/<skill> [request]" → the skill to invoke with the message.
 * Any slash word that is not a builtin counts: the menu's canonical name when
 * listed, else the word as typed, so the server answers an unknown one with
 * "No skill named X on this team." Builtins and non-slash text → null.
 */
export function skillInvocation(text: string, entries: readonly SlashMenuEntry[]): { invokedSkills: string[] } | null {
  const parsed = parseSlash(text);
  if (!parsed || findBuiltinSlash(text)) return null;
  const hit = entries.find((e) => e.entryKind === "skill" && e.name.toLowerCase() === parsed.name);
  return { invokedSkills: [hit?.name ?? parsed.name] };
}
