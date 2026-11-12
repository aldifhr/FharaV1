/**
 * Paradev C1: the one slash-command registry shared by the web composer and
 * the Convex intent code (plan audit/paradev-plan-2026-11-11.md, P-C).
 *
 * The wire type, `findSlashCommandByNameOrAlias`, `getCommandMatchRank`,
 * `shouldSuppressSlashMenuForCommittedCommand` and `sortSlashCommandMatches`
 * are copied from superset-sh/superset `packages/shared/src/slash-commands.ts`
 * (MIT, Copyright (c) 2025-2026 Superset Inc., THIRD_PARTY_NOTICES.md
 * "Paradev (superset-sh/superset)"). Changed by Fhara: no `trigger` field
 * (the composer only has "/"), builtins sort before custom entries (Fhara's
 * own commands lead the menu, skills follow), and a `scope` on builtins plus
 * the Fhara builtin list and `parseSlash` are added.
 *
 * Pure module: no Convex imports, so web (`@/api/convex/lib/slashCommands`)
 * and node tests can import it directly.
 */

/** What the entry is. Orthogonal to `kind`: a skill is custom+skill. */
export type SlashCommandEntryKind = "command" | "skill";

/** Provenance axis the sorter orders on: Fhara builtins sort first. */
export type SlashCommandKind = "custom" | "builtin";

/** Where the definition came from. Fhara uses `builtin` and `project` (skills). */
export type SlashCommandSource = "project" | "global" | "plugin" | "harness" | "builtin";

/** Which chat a builtin is offered in. */
export type SlashCommandScope = "project" | "personal";

export interface SlashCommandIdentity {
  name: string;
  aliases: string[];
}

export interface SlashCommand extends SlashCommandIdentity {
  description: string;
  /** Empty when the command takes no arguments. */
  argumentHint: string;
  kind: SlashCommandKind;
  source: SlashCommandSource;
  entryKind: SlashCommandEntryKind;
}

export interface FharaBuiltinCommand extends SlashCommand {
  kind: "builtin";
  source: "builtin";
  entryKind: "command";
  scope: SlashCommandScope[];
  /** Personal chat only: offered once a project is attached. */
  needsProject?: boolean;
}

function normalizeSlashCommandName(name: string): string {
  return name.trim().toLowerCase();
}

export function findSlashCommandByNameOrAlias<T extends SlashCommandIdentity>(commands: T[], nameOrAlias: string): T | null {
  const target = normalizeSlashCommandName(nameOrAlias);
  if (!target) return null;
  return (
    commands.find(
      (command) =>
        normalizeSlashCommandName(command.name) === target ||
        command.aliases.some((alias) => normalizeSlashCommandName(alias) === target)
    ) ?? null
  );
}

function getMatchRank(commandName: string, query: string): number | null {
  if (query === "") return 0;
  if (commandName === query) return 0;
  if (commandName.startsWith(query)) return 1;
  if (commandName.includes(query)) return 2;
  return null;
}

export function getCommandMatchRank<T extends SlashCommandIdentity>(command: T, query: string): number | null {
  const nameRank = getMatchRank(command.name.toLowerCase(), query);
  if (nameRank !== null) return nameRank;

  let bestAliasRank: number | null = null;
  for (const alias of command.aliases) {
    const rank = getMatchRank(alias.toLowerCase(), query);
    if (rank === null) continue;
    const aliasRank = rank + 3;
    if (bestAliasRank === null || aliasRank < bestAliasRank) {
      bestAliasRank = aliasRank;
    }
  }

  return bestAliasRank;
}

export function shouldSuppressSlashMenuForCommittedCommand<T extends SlashCommandIdentity & { argumentHint: string }>(
  query: string | null,
  commands: T[]
): boolean {
  if (!query) return false;
  const exactCommandMatch = findSlashCommandByNameOrAlias(commands, query);
  if (!exactCommandMatch) return false;
  return exactCommandMatch.argumentHint.trim().length > 0;
}

/** Fhara: builtins first, then rank, then name (Paradev puts builtins last). */
export function sortSlashCommandMatches<T extends SlashCommandIdentity & { kind: SlashCommandKind }>(
  matches: Array<{ command: T; rank: number }>
): T[] {
  return matches
    .sort((a, b) => {
      if (a.command.kind !== b.command.kind) {
        return a.command.kind === "builtin" ? -1 : 1;
      }
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.command.name.localeCompare(b.command.name);
    })
    .map((item) => item.command);
}

// ---------------------------------------------------------------------------
// Fhara builtins
// ---------------------------------------------------------------------------

const builtin = (
  name: string,
  argumentHint: string,
  description: string,
  scope: SlashCommandScope[],
  extra: Partial<Pick<FharaBuiltinCommand, "aliases" | "needsProject">> = {}
): FharaBuiltinCommand => ({
  name,
  aliases: extra.aliases ?? [],
  description,
  argumentHint,
  kind: "builtin",
  source: "builtin",
  entryKind: "command",
  scope,
  ...(extra.needsProject ? { needsProject: true } : {}),
});

/** The composer's builtin commands, in menu order. */
export const FHARA_BUILTIN_COMMANDS: readonly FharaBuiltinCommand[] = [
  builtin("task", "<what to do>", "Create a task from the rest of the message", ["project", "personal"], { needsProject: true }),
  builtin("research", "[2-6] <question>", "Research a question from several angles in parallel", ["project"]),
  builtin("memory", "<note>", "Remember a note (no note opens Memory)", ["project"]),
  builtin("qa", "[what to check]", "Ask QA to check the latest change", ["project"]),
  builtin("review", "[focus]", "Ask for a code review of the latest change", ["project"]),
  builtin("push", "", "Open the push waiting for your approval", ["project"]),
];

/**
 * The builtins a chat offers. A personal chat offers its personal-scoped
 * builtins, the `needsProject` ones only once a project is attached.
 */
export function builtinCommandsForScope(scope: SlashCommandScope, opts: { attached?: boolean } = {}): FharaBuiltinCommand[] {
  return FHARA_BUILTIN_COMMANDS.filter(
    (c) => c.scope.includes(scope) && !(scope === "personal" && c.needsProject && !opts.attached)
  );
}

/** A skill as a menu entry (built at runtime from `api.skills.list`). */
export function skillSlashEntry(skill: { name: string; description?: string | null }): SlashCommand {
  return {
    name: skill.name,
    aliases: [],
    description: skill.description ?? "",
    argumentHint: "[request]",
    kind: "custom",
    source: "project",
    entryKind: "skill",
  };
}

export interface ParsedSlash {
  /** The command name as typed, lower-cased ("research"). */
  name: string;
  /** Everything after the name, trimmed ("" when none). */
  args: string;
}

const SLASH_LINE = /^\/([a-z][\w-]*)(?=$|\s)\s*([\s\S]*)$/i;

/** "/research 3 why?" → { name: "research", args: "3 why?" }; not a slash line → null. */
export function parseSlash(text: string): ParsedSlash | null {
  const m = SLASH_LINE.exec(text.trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: m[2].trim() };
}

/** The registry builtin a slash line names (by name or alias), with its args; else null. */
export function findBuiltinSlash(text: string): { command: FharaBuiltinCommand; args: string } | null {
  const parsed = parseSlash(text);
  if (!parsed) return null;
  const command = findSlashCommandByNameOrAlias(FHARA_BUILTIN_COMMANDS as FharaBuiltinCommand[], parsed.name);
  return command ? { command, args: parsed.args } : null;
}
