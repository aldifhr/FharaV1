import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyInstructionBudget,
  INSTRUCTION_BLOCK_HEADER,
  nestedInstructionDirs,
  TRUNCATION_NOTE,
} from "@/api/convex/lib/projectInstructions";
import { projectInstructionChain, projectInstructionsBlock } from "@/context/projectInstructions";
import { turnUserContent } from "@/execution/turnContext";
import { resetTimeContextForTest } from "@/context/timeContext";
import { makeTempDir, removeTempDir } from "./helpers/tempRepo";

const ROOT_RULE = "ROOT-RULE: use npm, never yarn.";
const SRC_RULE = "SRC-RULE: every module exports one thing.";
const USER_RULE = "USER-RULE: answer in English.";

describe("project instruction chain (D4)", () => {
  let repo: string;
  let home: string;
  beforeEach(() => {
    repo = makeTempDir("fhara-d4-repo-");
    home = makeTempDir("fhara-d4-home-");
    fs.mkdirSync(path.join(repo, "src", "lib"), { recursive: true });
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repo, "AGENTS.md"), `${ROOT_RULE}\n`);
    fs.writeFileSync(path.join(repo, "src", "AGENTS.md"), `${SRC_RULE}\n`);
    fs.writeFileSync(path.join(home, "AGENTS.md"), `${USER_RULE}\n`);
    resetTimeContextForTest();
  });
  afterEach(() => {
    removeTempDir(repo);
    removeTempDir(home);
  });

  it("a src/** subtask sees the root and src/AGENTS.md; a docs/** subtask only the root", () => {
    const src = projectInstructionsBlock(repo, ["src/**"], { userGlobalPath: null });
    expect(src.startsWith(INSTRUCTION_BLOCK_HEADER)).toBe(true);
    expect(src).toContain(ROOT_RULE);
    expect(src).toContain(SRC_RULE);
    expect(src.indexOf(ROOT_RULE)).toBeLessThan(src.indexOf(SRC_RULE));

    const docs = projectInstructionsBlock(repo, ["docs/**"], { userGlobalPath: null });
    expect(docs).toContain(ROOT_RULE);
    expect(docs).not.toContain(SRC_RULE);
  });

  it("orders root, nested, then the user-global file", () => {
    const chain = projectInstructionChain(repo, ["src/lib/x.ts"], { userGlobalPath: path.join(home, "AGENTS.md") });
    expect(chain.entries.map((entry) => entry.path)).toEqual(["AGENTS.md", "src/AGENTS.md", "~/.fhara/AGENTS.md"]);
    expect(chain.dropped).toEqual([]);
  });

  it("over budget: the user file, then the root are dropped before the nested file is truncated", () => {
    const sources = [
      { scope: "root" as const, path: "AGENTS.md", depth: 0, text: "r".repeat(300) },
      { scope: "nested" as const, path: "src/AGENTS.md", depth: 1, text: "s".repeat(300) },
      { scope: "user" as const, path: "~/.fhara/AGENTS.md", depth: 0, text: "u".repeat(300) },
    ];
    const fitsTwo = applyInstructionBudget(sources, 650);
    expect(fitsTwo.dropped).toEqual(["~/.fhara/AGENTS.md"]);
    expect(fitsTwo.entries.map((e) => [e.path, e.truncated])).toEqual([["AGENTS.md", false], ["src/AGENTS.md", false]]);

    const fitsOne = applyInstructionBudget(sources, 400);
    expect(fitsOne.dropped).toEqual(["~/.fhara/AGENTS.md", "AGENTS.md"]);
    expect(fitsOne.entries).toHaveLength(1);
    expect(fitsOne.entries[0]).toMatchObject({ path: "src/AGENTS.md", truncated: false });

    const tight = applyInstructionBudget(sources, 200);
    expect(tight.dropped).toEqual(["~/.fhara/AGENTS.md", "AGENTS.md"]);
    expect(tight.entries[0].path).toBe("src/AGENTS.md");
    expect(tight.entries[0].truncated).toBe(true);
    expect(tight.entries[0].text.endsWith(TRUNCATION_NOTE)).toBe(true);
    expect(tight.entries[0].text.length).toBeLessThanOrEqual(200);
  });

  it("derives nested directories from globs and file paths, refusing escapes", () => {
    expect(nestedInstructionDirs(["src/**", "apps/web/components/A.tsx", "docs/", "../x", "/etc", ".github/x"])).toEqual([
      "apps",
      "docs",
      "src",
      "apps/web",
      "apps/web/components",
    ]);
  });

  it("skips an AGENTS.md symlink that leaves the workspace", () => {
    fs.mkdirSync(path.join(repo, "evil"));
    fs.symlinkSync(path.join(home, "AGENTS.md"), path.join(repo, "evil", "AGENTS.md"));
    const block = projectInstructionsBlock(repo, ["evil/**"], { userGlobalPath: null });
    expect(block).not.toContain(USER_RULE);
  });

  it("the API-path user turn carries the chain first and the time line last", () => {
    const content = turnUserContent(repo, ["src/**"], ["Shared task context:\nprior", "Task: do it"], Date.UTC(2026, 10, 11, 17, 24));
    expect(content.indexOf(ROOT_RULE)).toBeLessThan(content.indexOf("Task: do it"));
    expect(content.trimEnd().split("\n").at(-1)).toBe("Current time: Thu 2026-11-12 00:24 (Asia/Jakarta, UTC+07:00).");
    expect(content.match(/ROOT-RULE/g)).toHaveLength(1);
  });
});
