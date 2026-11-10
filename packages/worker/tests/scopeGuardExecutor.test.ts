import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GlobalLLMConfig, LLMMessage, LLMProvider } from "@/llm";
import type { FallbackHandle } from "@/effects/llmCall";
import { executeSubtask, type SubtaskExecutionInput } from "@/execution/agentExecutor";
import type { FileDiff } from "@/tools/gitDiff";

/** Live test 4: a JSDoc-only request must not rewrite formatRupiah's output. */
const FORMAT = "function formatRupiah(n) {\n  return 'Rp ' + n.toLocaleString('id-ID');\n}\nmodule.exports = { formatRupiah };\n";
const DOCUMENTED = `/**\n * Format a number as Rupiah.\n * @param {number} n\n */\n${FORMAT}`;
const REWRITTEN = "/** Rupiah */\nfunction formatRupiah(n) {\n  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(n);\n}\nmodule.exports = { formatRupiah };\n";

describe("scope guard in the implementer (one corrective retry)", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-scope-"));
    await fs.mkdir(path.join(workspace, "src", "lib"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "lib", "format.js"), FORMAT);
  });
  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const config: GlobalLLMConfig = { provider: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9", apiKey: "k" };
  function input(provider: LLMProvider, saved: FileDiff[], events: Array<{ type: string; payload: any }>): SubtaskExecutionInput {
    const handle: FallbackHandle = { connectionId: "c", connectionName: "t", config, provider };
    return {
      workspacePath: workspace,
      command: "tambahkan komentar JSDoc pada fungsi formatRupiah di src/lib/format.js",
      plan: { version: 1, goal: "g", strategy: "single", requiresApproval: false, maxConcurrency: 1, subtasks: [] },
      subtask: { key: "doc", title: "doc", description: "Add JSDoc to formatRupiah", kind: "code_change", capability: "backend-development", dependencies: [], order: 0 },
      agent: { _id: "a", name: "Backend", role: "backend", capabilities: ["backend-development"] },
      llmHandles: [handle],
      priorOutputs: new Map(),
      fileChanges: [],
      getStagedChange: () => undefined,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 10 * 60_000,
      onEvent: async (type: string, payload: any) => {
        events.push({ type, payload });
      },
      onMessage: async () => undefined,
      onChunk: async () => undefined,
      saveFileChange: async (change) => {
        saved.push(change);
      },
    };
  }

  it("sends an out-of-scope answer back once and stages the corrected one", async () => {
    const prompts: string[] = [];
    const saved: FileDiff[] = [];
    const events: Array<{ type: string; payload: any }> = [];
    const provider: LLMProvider = {
      complete: async (messages: LLMMessage[]) => {
        prompts.push(messages.map((m) => m.content).join("\n"));
        const content = prompts.length === 1 ? REWRITTEN : DOCUMENTED;
        return { content: JSON.stringify({ files: [{ filePath: "src/lib/format.js", newContent: content }] }) };
      },
    };
    const result = await executeSubtask(input(provider, saved, events));
    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("REJECTED by the scope guard");
    expect(saved.at(-1)?.newContent).toBe(DOCUMENTED);
    expect(events.filter((e) => e.type === "scope.violation").map((e) => e.payload.attempt)).toEqual([1, 2]);
    expect((result as { meta?: { scopeWarnings?: string[] } }).meta?.scopeWarnings).toBeUndefined();
  });

  it("keeps the change but carries a warning when the retry still violates scope", async () => {
    const saved: FileDiff[] = [];
    const events: Array<{ type: string; payload: any }> = [];
    let calls = 0;
    const provider: LLMProvider = {
      complete: async () => {
        calls += 1;
        return { content: JSON.stringify({ files: [{ filePath: "src/lib/format.js", newContent: REWRITTEN }] }) };
      },
    };
    const result = await executeSubtask(input(provider, saved, events));
    expect(calls).toBe(2);
    expect(result.status).toBe("completed");
    const meta = (result as { meta?: { scopeWarnings?: string[] } }).meta;
    expect(meta?.scopeWarnings?.[0]).toContain("documentation-only");
    expect((result as { output?: string }).output).toContain("Scope warning");
  });
});
