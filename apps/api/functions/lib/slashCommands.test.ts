/**
 * Paradev C1 registry tests. The ranking / sort / suppress / find cases are
 * ported from superset-sh/superset `packages/shared/src/slash-commands.test.ts`
 * (MIT, Copyright (c) 2025-2026 Superset Inc., THIRD_PARTY_NOTICES.md
 * "Paradev (superset-sh/superset)"), with the sort case flipped for Fhara's
 * builtins-first order.
 */
import { describe, expect, it } from "vitest";
import {
  FHARA_BUILTIN_COMMANDS,
  builtinCommandsForScope,
  findBuiltinSlash,
  findSlashCommandByNameOrAlias,
  getCommandMatchRank,
  parseSlash,
  shouldSuppressSlashMenuForCommittedCommand,
  skillSlashEntry,
  sortSlashCommandMatches,
  type SlashCommand,
} from "./slashCommands";
import { explicitTaskCommand } from "./chat/intent";
import { researchFanoutRequest } from "../../../../packages/worker/src/prompts/research";

function command(overrides: Partial<SlashCommand> & { name: string }): SlashCommand {
  return {
    aliases: [],
    description: "",
    argumentHint: "",
    kind: "custom",
    source: "project",
    entryKind: "command",
    ...overrides,
  };
}

describe("getCommandMatchRank", () => {
  it("ranks exact, prefix, then substring matches", () => {
    const deslop = command({ name: "deslop" });
    expect(getCommandMatchRank(deslop, "deslop")).toBe(0);
    expect(getCommandMatchRank(deslop, "des")).toBe(1);
    expect(getCommandMatchRank(deslop, "slop")).toBe(2);
    expect(getCommandMatchRank(deslop, "xyz")).toBeNull();
  });

  it("matches everything on an empty query", () => {
    expect(getCommandMatchRank(command({ name: "anything" }), "")).toBe(0);
  });

  it("offsets alias matches below name matches", () => {
    const fresh = command({ name: "new", aliases: ["clear"] });
    expect(getCommandMatchRank(fresh, "clear")).toBe(3);
    expect(getCommandMatchRank(fresh, "cle")).toBe(4);
  });
});

describe("sortSlashCommandMatches", () => {
  it("sorts builtins first (Fhara), then by rank, then by name", () => {
    const sorted = sortSlashCommandMatches([
      { command: command({ name: "model", kind: "builtin" }), rank: 0 },
      { command: command({ name: "zeta" }), rank: 1 },
      { command: command({ name: "alpha" }), rank: 1 },
      { command: command({ name: "beta" }), rank: 0 },
    ]);
    expect(sorted.map((entry) => entry.name)).toEqual(["model", "beta", "alpha", "zeta"]);
  });

  it("puts /research before /review for '/re' and builtins before a skill", () => {
    const entries: SlashCommand[] = [skillSlashEntry({ name: "react-patterns", description: "x" }), ...FHARA_BUILTIN_COMMANDS];
    const matches = entries
      .map((c) => ({ command: c, rank: getCommandMatchRank(c, "re") }))
      .filter((m): m is { command: SlashCommand; rank: number } => m.rank !== null);
    expect(sortSlashCommandMatches(matches).map((c) => c.name)).toEqual(["research", "review", "react-patterns"]);
  });
});

describe("shouldSuppressSlashMenuForCommittedCommand", () => {
  it("suppresses only when the committed command takes arguments", () => {
    const commands = [command({ name: "refactor", argumentHint: "<scope>" }), command({ name: "deslop" })];
    expect(shouldSuppressSlashMenuForCommittedCommand("refactor", commands)).toBe(true);
    expect(shouldSuppressSlashMenuForCommittedCommand("deslop", commands)).toBe(false);
    expect(shouldSuppressSlashMenuForCommittedCommand("nope", commands)).toBe(false);
    expect(shouldSuppressSlashMenuForCommittedCommand(null, commands)).toBe(false);
  });

  it("applies to the Fhara builtins: /research suppresses, /push does not", () => {
    const builtins = [...FHARA_BUILTIN_COMMANDS];
    expect(shouldSuppressSlashMenuForCommittedCommand("research", builtins)).toBe(true);
    expect(shouldSuppressSlashMenuForCommittedCommand("push", builtins)).toBe(false);
  });
});

describe("findSlashCommandByNameOrAlias", () => {
  it("finds by name or alias, case-insensitively", () => {
    const commands = [command({ name: "new", aliases: ["Clear"] })];
    expect(findSlashCommandByNameOrAlias(commands, "NEW")?.name).toBe("new");
    expect(findSlashCommandByNameOrAlias(commands, "clear")?.name).toBe("new");
    expect(findSlashCommandByNameOrAlias(commands, "")).toBeNull();
  });
});

describe("Fhara builtins", () => {
  it("lists the six builtins in menu order, each with a description", () => {
    expect(FHARA_BUILTIN_COMMANDS.map((c) => c.name)).toEqual(["task", "research", "memory", "qa", "review", "push"]);
    for (const c of FHARA_BUILTIN_COMMANDS) {
      expect(c.kind).toBe("builtin");
      expect(c.description.length).toBeGreaterThan(0);
    }
    expect(FHARA_BUILTIN_COMMANDS.find((c) => c.name === "push")?.argumentHint).toBe("");
  });

  it("filters by scope; personal /task needs an attached project", () => {
    expect(builtinCommandsForScope("project").map((c) => c.name)).toEqual(["task", "research", "memory", "qa", "review", "push"]);
    expect(builtinCommandsForScope("personal").map((c) => c.name)).toEqual([]);
    expect(builtinCommandsForScope("personal", { attached: true }).map((c) => c.name)).toEqual(["task"]);
  });

  it("builds a skill entry from a skill row", () => {
    expect(skillSlashEntry({ name: "frontend-design", description: "Design UIs" })).toMatchObject({
      name: "frontend-design",
      entryKind: "skill",
      kind: "custom",
      argumentHint: "[request]",
      description: "Design UIs",
    });
  });
});

describe("parseSlash / findBuiltinSlash", () => {
  it("splits name and args", () => {
    expect(parseSlash("/research 3 why is the sky blue?")).toEqual({ name: "research", args: "3 why is the sky blue?" });
    expect(parseSlash("  /PUSH  ")).toEqual({ name: "push", args: "" });
    expect(parseSlash("/memory\nUse pnpm")).toEqual({ name: "memory", args: "Use pnpm" });
  });

  it("is not a slash line for plain text, paths or a glued word", () => {
    expect(parseSlash("hello /task x")).toBeNull();
    expect(parseSlash("/usr/bin/node")).toBeNull();
    expect(parseSlash("/")).toBeNull();
  });

  it("finds registry builtins only", () => {
    expect(findBuiltinSlash("/review auth flow")?.command.name).toBe("review");
    expect(findBuiltinSlash("/review auth flow")?.args).toBe("auth flow");
    expect(findBuiltinSlash("/frontend-design make it nice")).toBeNull();
  });
});

describe("/research detection agrees across intent.ts and the worker", () => {
  it("'/research 3 q' is a task command and a 3-angle fan-out", () => {
    const line = "/research 3 which vector DB fits us";
    expect(explicitTaskCommand(line)).toBe(line);
    expect(researchFanoutRequest(line)).toEqual({ question: "which vector DB fits us", angles: 3 });
  });

  it("'/research q' uses the default fan-out; bare '/research' is neither", () => {
    expect(explicitTaskCommand("/research why")).toBe("/research why");
    expect(researchFanoutRequest("/research why")?.question).toBe("why");
    expect(explicitTaskCommand("/research")).toBeNull();
    expect(researchFanoutRequest("/research")).toBeNull();
    expect(explicitTaskCommand("/researcher why")).toBeNull();
    expect(researchFanoutRequest("/researcher why")).toBeNull();
  });
});
