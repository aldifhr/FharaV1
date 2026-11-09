import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GlobalLLMConfig, LLMMessage, LLMProvider } from "@/llm";
import type { FallbackHandle } from "@/effects/llmCall";
import {
  dropsStagedEdit,
  executeSubtask,
  parseCodeChangeAnswer,
  reconcileWithStaged,
  stagedChangesContext,
  type SubtaskExecutionInput,
} from "@/execution/agentExecutor";
import { diffFromContents, type FileDiff } from "@/tools/gitDiff";
import { classifyToolCalls, parseToolCallMarkup, stripToolCallMarkup } from "@/utils/toolCallMarkup";

const HEADER = '<header>\n  <h1>Demo</h1>\n</header>\n<main>Hello</main>\n';
const HEADER_WITH_TOGGLE = '<header>\n  <h1>Demo</h1>\n  <button id="theme-toggle">Dark mode</button>\n</header>\n<main>Hello</main>\n';

describe("longcat tool-call markup", () => {
  it("parses JSON-style calls and strips the markup", () => {
    const content =
      'Let me look first.\n<longcat_tool_call>{"name":"read_file","arguments":{"path":"src/header.js"}}</longcat_tool_call>\n<longcat_tool_call>{"name":"read_file","arguments":"{\\"path\\":\\"./README.md\\"}"}</longcat_tool_call>';
    const parsed = parseToolCallMarkup(content);
    expect(parsed.hadMarkup).toBe(true);
    expect(parsed.stripped).toBe("Let me look first.");
    expect(classifyToolCalls(parsed.calls).readPaths).toEqual(["src/header.js", "README.md"]);
  });

  it("parses XML arg_key/arg_value calls, bare paths and unclosed blocks", () => {
    const xml =
      "<longcat_tool_call>read_file\n<longcat_arg_key>path</longcat_arg_key>\n<longcat_arg_value>index.html</longcat_arg_value>\n</longcat_tool_call>";
    expect(classifyToolCalls(parseToolCallMarkup(xml).calls).readPaths).toEqual(["index.html"]);
    expect(classifyToolCalls(parseToolCallMarkup("<longcat_tool_call>src/app.js</longcat_tool_call>").calls).readPaths).toEqual(["src/app.js"]);
    const unclosed = parseToolCallMarkup('ok <longcat_tool_call>{"name":"view","arguments":{"file_path":"a.css"}}');
    expect(unclosed.stripped).toBe("ok");
    expect(classifyToolCalls(unclosed.calls).readPaths).toEqual(["a.css"]);
    expect(stripToolCallMarkup("a</longcat_tool_call>b")).toBe("ab");
  });

  it("a full-file write tool call becomes a draft; a JSON answer next to markup still parses", () => {
    const write =
      '<longcat_tool_call>{"name":"write_file","arguments":{"path":"src/x.js","content":"export const x = 1;\\n"}}</longcat_tool_call>';
    expect(parseCodeChangeAnswer(write).draft).toEqual({ files: [{ filePath: "src/x.js", newContent: "export const x = 1;\n" }] });
    const mixed =
      '<longcat_tool_call>{"name":"read_file","arguments":{"path":"a.js"}}</longcat_tool_call>\n{"files":[{"filePath":"b.js","newContent":"b"}]}';
    const parsed = parseCodeChangeAnswer(mixed);
    expect(parsed.draft).toEqual({ files: [{ filePath: "b.js", newContent: "b" }] });
    expect(parsed.readPaths).toEqual(["a.js"]);
  });
});

describe("staged edits are kept by later nodes", () => {
  it("dropsStagedEdit spots a proposal written from the disk version", () => {
    const fromDisk = HEADER.replace("Demo", "Demo App");
    expect(dropsStagedEdit(HEADER, HEADER_WITH_TOGGLE, fromDisk)).toBe(true);
    expect(dropsStagedEdit(HEADER, HEADER_WITH_TOGGLE, HEADER_WITH_TOGGLE.replace("Demo", "Demo App"))).toBe(false);
    // A refactor that moves the header out entirely is not a dropped edit.
    expect(dropsStagedEdit(HEADER, HEADER_WITH_TOGGLE, '<div id="header-root"></div>\n<main>Hello</main>\n')).toBe(false);
  });

  it("a node that saw the staged content and reverts it is trusted (intentional move) but flagged", async () => {
    const staged = diffFromContents("index.html", HEADER, HEADER_WITH_TOGGLE);
    const result = await reconcileWithStaged({ diskContent: HEADER, seen: staged, current: staged, proposed: HEADER });
    // e2e ULTRA: the header refactor moved the toggle out of main.js into
    // header.js; re-merging it back would have duplicated the toggle.
    expect(result).toEqual({ ok: true, content: HEADER, revertsStaged: true });
  });

  it("merges a concurrent node's edit, and fails on a real conflict", async () => {
    const concurrent = diffFromContents("index.html", HEADER, HEADER_WITH_TOGGLE);
    const merged = await reconcileWithStaged({
      diskContent: HEADER,
      seen: undefined,
      current: concurrent,
      proposed: HEADER.replace("<main>Hello</main>", "<main>Hi</main>"),
    });
    expect(merged.ok && merged.content).toBe(HEADER_WITH_TOGGLE.replace("<main>Hello</main>", "<main>Hi</main>"));
    const conflict = await reconcileWithStaged({
      diskContent: HEADER,
      seen: undefined,
      current: concurrent,
      proposed: HEADER.replace("<h1>Demo</h1>", "<h1>Demo</h1>\n  <nav>x</nav>"),
    });
    expect(conflict.ok).toBe(false);
  });
});

describe("executeSubtask code_change (sequential nodes on one file)", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-staged-"));
    await fs.writeFile(path.join(workspace, "index.html"), HEADER);
    await fs.writeFile(path.join(workspace, "header.js"), "export const header = 1;\n");
  });
  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const config: GlobalLLMConfig = { provider: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9", apiKey: "k" };
  function input(provider: LLMProvider, staged: Map<string, FileDiff>, key: string, saved: FileDiff[]): SubtaskExecutionInput {
    const handle: FallbackHandle = { connectionId: "c", connectionName: "t", config, provider };
    return {
      workspacePath: workspace,
      command: "Add dark mode toggle and refactor header",
      plan: { version: 1, goal: "g", strategy: "single", requiresApproval: false, maxConcurrency: 1, subtasks: [] },
      subtask: { key, title: key, description: "Edit index.html", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0 },
      agent: { _id: "a", name: "Frontend", role: "frontend", capabilities: ["frontend-development"] },
      llmHandles: [handle],
      priorOutputs: new Map(),
      fileChanges: Array.from(staged.values()),
      getStagedChange: (filePath) => staged.get(filePath),
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 10 * 60_000,
      onEvent: async () => undefined,
      onMessage: async () => undefined,
      onChunk: async () => undefined,
      saveFileChange: async (change) => {
        staged.set(change.filePath, change);
        saved.push(change);
      },
    };
  }

  it("node 2 sees node 1's staged content and its edit lands on top of it", async () => {
    const staged = new Map<string, FileDiff>();
    const saved: FileDiff[] = [];
    const prompts: string[] = [];
    const node1: LLMProvider = {
      complete: async () => ({ content: JSON.stringify({ files: [{ filePath: "index.html", newContent: HEADER_WITH_TOGGLE }] }) }),
    };
    expect((await executeSubtask(input(node1, staged, "dark-mode", saved))).status).toBe("completed");

    // Node 2 builds on the staged content it was shown.
    const node2: LLMProvider = {
      complete: async (messages: LLMMessage[]) => {
        const prompt = messages.map((m) => m.content).join("\n");
        prompts.push(prompt);
        const shown = prompt.includes('id="theme-toggle"') ? HEADER_WITH_TOGGLE : HEADER;
        return { content: JSON.stringify({ files: [{ filePath: "index.html", newContent: shown.replace("Hello", "Hello world") }] }) };
      },
    };
    expect((await executeSubtask(input(node2, staged, "refactor", saved))).status).toBe("completed");
    expect(prompts[0]).toContain("index.html (staged modified)");
    expect(prompts[0]).toContain('id="theme-toggle"');
    const final = staged.get("index.html")!;
    expect(final.newContent).toContain('id="theme-toggle"');
    expect(final.newContent).toContain("Hello world");
    // The diff is still against disk, so approval shows both edits.
    expect(final.oldContent).toBe(HEADER);
    expect(final.diff).toContain("theme-toggle");
    expect(final.diff).toContain("Hello world");
  });

  it("a tool-call answer gets the requested file and one retry", async () => {
    const staged = new Map<string, FileDiff>();
    const saved: FileDiff[] = [];
    const prompts: string[] = [];
    const provider: LLMProvider = {
      complete: async (messages: LLMMessage[]) => {
        prompts.push(messages.map((m) => m.content).join("\n"));
        return prompts.length === 1
          ? { content: '<longcat_tool_call>{"name":"read_file","arguments":{"path":"header.js"}}</longcat_tool_call>' }
          : { content: JSON.stringify({ files: [{ filePath: "header.js", newContent: "export const header = 2;\n" }] }) };
      },
    };
    const result = await executeSubtask(input(provider, staged, "refactor", saved));
    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Files you asked for:\n--- header.js ---\nexport const header = 1;");
    expect(prompts[1]).toContain("Tools are NOT available");
    expect(prompts[1]).not.toContain("longcat_tool_call");
    expect(saved.map((c) => c.filePath)).toEqual(["header.js"]);
  });

  it("a concurrent node's staged edit is merged into a later write of the same file", async () => {
    const staged = new Map<string, FileDiff>();
    const saved: FileDiff[] = [];
    // Node B starts before node A stages anything (empty snapshot) ...
    const nodeB: LLMProvider = {
      complete: async () => {
        // ... and A stages its toggle while B's LLM call is in flight.
        staged.set("index.html", diffFromContents("index.html", HEADER, HEADER_WITH_TOGGLE));
        return { content: JSON.stringify({ files: [{ filePath: "index.html", newContent: HEADER.replace("Hello", "Hello world") }] }) };
      },
    };
    const result = await executeSubtask(input(nodeB, staged, "readme", saved));
    expect(result.status).toBe("completed");
    const final = staged.get("index.html")!;
    expect(final.newContent).toContain('id="theme-toggle"');
    expect(final.newContent).toContain("Hello world");
  });

  it("stagedChangesContext lists deleted files and caps size", () => {
    const deleted: FileDiff = { filePath: "old.js", changeType: "deleted", oldContent: "x", diff: "" };
    expect(stagedChangesContext([deleted])).toContain("old.js (staged: DELETED)");
    expect(stagedChangesContext([])).toBe("");
  });
});

describe("scheduler notices a cancel while a node is still running", () => {
  it("aborts the running node within the poll interval", async () => {
    const { runScheduler } = await import("@/scheduler/dagScheduler");
    let cancelled = false;
    setTimeout(() => {
      cancelled = true;
    }, 100);
    const started = Date.now();
    const result = await runScheduler(
      [{ id: "slow", dependencies: [] }],
      (_node, signal) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ status: "completed" }), 60_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve({ status: "failed", error: "aborted" });
          });
        }),
      {
        maxConcurrency: 1,
        timeoutMs: 120_000,
        retries: 0,
        cancelPollMs: 50,
        shouldCancel: async () => cancelled,
        onStart: async () => undefined,
        onOutcome: async () => undefined,
      }
    );
    expect(result.status).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("review parsing is tolerant of real model output", () => {
  it("accepts prose/markup around the verdict, missing suggestion and odd severities", async () => {
    const { parseReview } = await import("@/utils/json");
    const content =
      'Looks fine overall.\n<longcat_tool_call>{"name":"read_file","arguments":{"path":"a.js"}}</longcat_tool_call>\n{"verdict":"approved","findings":[{"severity":"info","filePath":"a.js","description":"nit"},"plain note"]}';
    const { stripToolCallMarkup: strip } = await import("@/utils/toolCallMarkup");
    expect(parseReview(strip(content))).toEqual({
      verdict: "approved",
      findings: [
        { severity: "low", filePath: "a.js", description: "nit", suggestion: "" },
        { severity: "low", filePath: "", description: "plain note", suggestion: "" },
      ],
    });
    // A nested object first, the verdict object after it.
    expect(parseReview('{"note":"x"} then {"verdict":"changes_requested","findings":[{"severity":"major","description":"bug"}]}')?.findings[0].severity).toBe("high");
    expect(parseReview('{"verdict":"maybe","findings":[]}')).toBeNull();
    expect(parseReview("no json")).toBeNull();
  });
});

describe("review node retries an unparseable answer once", () => {
  it("second answer is used", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      complete: async () => {
        calls += 1;
        return { content: calls === 1 ? "I reviewed it, all good." : '{"verdict":"approved","findings":[]}' };
      },
    };
    const config: GlobalLLMConfig = { provider: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9", apiKey: "k" };
    const handle: FallbackHandle = { connectionId: "c", connectionName: "t", config, provider };
    const change = diffFromContents("index.html", HEADER, HEADER_WITH_TOGGLE);
    const result = await executeSubtask({
      workspacePath: os.tmpdir(),
      command: "review",
      plan: { version: 1, goal: "g", strategy: "single", requiresApproval: false, maxConcurrency: 1, subtasks: [] },
      subtask: { key: "review", title: "Review", description: "Review", kind: "review", capability: "code-review", dependencies: [], order: 0 },
      agent: { _id: "r", name: "Reviewer", role: "reviewer", capabilities: ["code-review"] },
      llmHandles: [handle],
      priorOutputs: new Map(),
      fileChanges: [change],
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 10 * 60_000,
      onEvent: async () => undefined,
      onMessage: async () => undefined,
      onChunk: async () => undefined,
      saveFileChange: async () => undefined,
    });
    expect(calls).toBe(2);
    expect(result.status).toBe("completed");
    expect((result as { meta?: { verdict?: string } }).meta?.verdict).toBe("approved");
  });
});

describe("an empty model answer is retryable, not a permanent parse failure", () => {
  it("is not classified permanent by the scheduler", async () => {
    const { EMPTY_MODEL_ANSWER_ERROR } = await import("@/execution/agentExecutor");
    const { isPermanentSubtaskError, shouldRetrySubtask } = await import("@/scheduler/dagScheduler");
    for (const kind of ["review", "implementation"] as const) {
      expect(isPermanentSubtaskError(EMPTY_MODEL_ANSWER_ERROR(kind))).toBe(false);
      expect(shouldRetrySubtask(EMPTY_MODEL_ANSWER_ERROR(kind))).toBe(true);
    }
    expect(isPermanentSubtaskError("The review agent returned an unparseable review; refusing to proceed")).toBe(true);
  });
});

describe("a later node returning a staged file to its pre-task content", () => {
  it("withdraws the staged edit instead of failing as a no-op", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-revert-"));
    try {
      await fs.writeFile(path.join(workspace, "main.js"), "render();\n");
      const staged = new Map<string, FileDiff>([["main.js", diffFromContents("main.js", "render();\n", "render();\naddToggle();\n")]]);
      const discarded: string[] = [];
      const config: GlobalLLMConfig = { provider: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9", apiKey: "k" };
      const provider: LLMProvider = {
        complete: async () => ({ content: JSON.stringify({ files: [{ filePath: "main.js", newContent: "render();\n" }] }) }),
      };
      const handle: FallbackHandle = { connectionId: "c", connectionName: "t", config, provider };
      const result = await executeSubtask({
        workspacePath: workspace,
        command: "remove the duplicate toggle",
        plan: { version: 1, goal: "g", strategy: "single", requiresApproval: false, maxConcurrency: 1, subtasks: [] },
        subtask: { key: "review_fix_1", title: "fix", description: "Delete the duplicate toggle block in main.js", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0 },
        agent: { _id: "a", name: "Frontend", role: "frontend", capabilities: ["frontend-development"] },
        llmHandles: [handle],
        priorOutputs: new Map(),
        fileChanges: Array.from(staged.values()),
        getStagedChange: (filePath) => staged.get(filePath),
        discardFileChange: async (filePath) => {
          discarded.push(filePath);
          staged.delete(filePath);
        },
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 10 * 60_000,
        onEvent: async () => undefined,
        onMessage: async () => undefined,
        onChunk: async () => undefined,
        saveFileChange: async () => undefined,
      });
      expect(result.status).toBe("completed");
      expect(discarded).toEqual(["main.js"]);
      expect((result as { meta?: { revertedPaths?: string[] } }).meta?.revertedPaths).toEqual(["main.js"]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
