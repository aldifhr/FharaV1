import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitWorktree, describeCommit } from "@/tools/gitWorktree";
import { generateCommitMessage } from "@/services/runner/commitMessage";
import { COMMIT_MESSAGE_RE, COMMIT_SYSTEM_PROMPT, buildCommitMessagePrompt, normalizeCommitMessage } from "@/prompts/commit";
import { BudgetExhaustedError } from "@/orchestrator/budget";
import { createTempGitRepo } from "./helpers/tempRepo";

const DIFF = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n";

describe("R9 commit prompt (Aider commit_system)", () => {
  it("keeps Aider's wording and builds the '# Diffs:' message", () => {
    expect(COMMIT_SYSTEM_PROMPT).toContain("The commit message should be structured as follows: <type>: <description>");
    expect(COMMIT_SYSTEM_PROMPT).toContain("Use these for <type>: fix, feat, build, chore, ci, docs, style, refactor, perf, test");
    expect(buildCommitMessagePrompt("D", "Task: x")).toBe("Task: x\n# Diffs:\nD");
    expect(buildCommitMessagePrompt("x".repeat(30_000)).endsWith("... (diff truncated)")).toBe(true);
  });

  it("accepts only one conventional line of at most 72 description chars", () => {
    expect(normalizeCommitMessage('"fix: handle empty input"')).toBe("fix: handle empty input");
    expect(normalizeCommitMessage("feat: add dark mode\n\nextra")).toBe("feat: add dark mode");
    expect(normalizeCommitMessage("Added dark mode")).toBeNull();
    expect(normalizeCommitMessage(`fix: ${"a".repeat(73)}`)).toBeNull();
    expect(COMMIT_MESSAGE_RE.test("refactor: split runner")).toBe(true);
  });
});

describe("R9 generateCommitMessage", () => {
  it("runs the budget gate before the LLM call", async () => {
    const order: string[] = [];
    const message = await generateCommitMessage(DIFF, {
      agent: null,
      assertBudgetForCall: () => order.push("gate"),
      ask: async () => {
        order.push("llm");
        return "fix: change one to two";
      },
    });
    expect(message).toBe("fix: change one to two");
    expect(message).toMatch(/^(fix|feat|build|chore|ci|docs|style|refactor|perf|test): .{1,72}$/);
    expect(order).toEqual(["gate", "llm"]);
  });

  it("over budget: no LLM call, fallback", async () => {
    const ask = vi.fn(async () => "fix: x");
    const onFallback = vi.fn();
    const message = await generateCommitMessage(DIFF, {
      agent: null,
      assertBudgetForCall: () => {
        throw new BudgetExhaustedError("LLM call budget exhausted");
      },
      ask,
      onFallback,
    });
    expect(message).toBeNull();
    expect(ask).not.toHaveBeenCalled();
    expect(onFallback.mock.calls[0][0]).toMatch(/^budget:/);
  });

  it("LLM failure, a bad reply, no chain or the off switch: fallback", async () => {
    expect(await generateCommitMessage(DIFF, { agent: null, ask: async () => { throw new Error("503"); } })).toBeNull();
    expect(await generateCommitMessage(DIFF, { agent: null, ask: async () => "I changed one to two." })).toBeNull();
    expect(await generateCommitMessage(DIFF, { agent: null })).toBeNull();
    const ask = vi.fn(async () => "fix: x");
    expect(await generateCommitMessage(DIFF, { agent: null, ask, env: { FHARA_COMMIT_MESSAGE_LLM: "0" } })).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("R9 commitWorktree with a diff-based message", () => {
  it("commits with the generated message, which the push card reads", async () => {
    const { dir, cleanup } = createTempGitRepo({ prefix: "fhara-r9-" });
    try {
      writeFileSync(join(dir, "a.txt"), "one\n");
      let seenDiff = "";
      const committed = await commitWorktree(dir, "Fhara: Change a", ["a.txt"], {
        messageFromDiff: async (diff) => {
          seenDiff = diff;
          return generateCommitMessage(diff, { agent: null, ask: async () => "feat: add a.txt" });
        },
      });
      expect(committed).toBe(true);
      expect(seenDiff).toContain("+one");
      expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: dir, encoding: "utf-8" }).trim()).toBe("feat: add a.txt");
      expect((await describeCommit(dir, "main")).message).toBe("feat: add a.txt");
    } finally {
      cleanup();
    }
  });

  it("falls back to 'Fhara: <title>' when generation fails", async () => {
    const { dir, cleanup } = createTempGitRepo({ prefix: "fhara-r9-" });
    try {
      writeFileSync(join(dir, "b.txt"), "two\n");
      await commitWorktree(dir, "Fhara: Change b", ["b.txt"], {
        messageFromDiff: (diff) =>
          generateCommitMessage(diff, {
            agent: null,
            assertBudgetForCall: () => {
              throw new BudgetExhaustedError("spent");
            },
            ask: async () => "feat: never",
          }),
      });
      expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: dir, encoding: "utf-8" }).trim()).toBe("Fhara: Change b");
      await commitWorktree(dir, "Fhara: thrown", undefined, {
        messageFromDiff: async () => {
          throw new Error("boom");
        },
      }).catch(() => undefined);
    } finally {
      cleanup();
    }
  });
});
