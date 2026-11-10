import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildRepoMap, clearRepoMapMemory, extractTags, fitToBudget, mentionedIdents } from "@/execution/repoMap";
import { exploreRepository } from "@/execution/repositoryContext";
import { loadTypescript } from "@/execution/tsRuntime";
import { pagerank } from "@/utils/pagerank";
import { planningPrompt } from "@/prompts/planner";

/** R7 (multi-repo adoption): ranked repo map from the TypeScript compiler. */

describe("pagerank", () => {
  it("ranks the node everything points to highest and honours personalisation", () => {
    const edges = new Map([
      ["a", new Map([["c", 1]])],
      ["b", new Map([["c", 1]])],
      ["c", new Map([["a", 1]])],
    ]);
    const plain = pagerank(["a", "b", "c", "d"], edges);
    expect([...plain.entries()].sort((x, y) => y[1] - x[1])[0][0]).toBe("c");
    const total = [...plain.values()].reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 6);
    const personal = pagerank(["a", "b", "c", "d"], edges, new Map([["d", 1]]));
    expect(personal.get("d")!).toBeGreaterThan(plain.get("d")!);
  });
});

describe("extractTags", () => {
  const ts = loadTypescript()!;
  it("records top-level definitions, cross-file references and imports; not locals or package names", () => {
    const tags = extractTags(
      ts,
      "src/a.tsx",
      [
        'import { render } from "@testing-library/react";',
        'import { shouldCompact } from "./context/compaction";',
        "export interface Options { limit: number }",
        "export function run(options: Options) {",
        "  const helper = () => 1;",
        "  function inner() { return helper(); }",
        "  render(<Panel />);",
        "  return shouldCompact([]) && inner() && list.push(1);",
        "}",
        "export class Store { load(): void {} }",
      ].join("\n")
    );
    expect(tags.defs.map((def) => def.name)).toEqual(["Options", "run", "Store", "load"]);
    expect(tags.defs[1].text).toBe("export function run(options: Options)");
    expect(Object.keys(tags.refs).sort()).toEqual(["Options", "Panel", "shouldCompact"]);
    expect(tags.imports).toEqual(["@testing-library/react", "./context/compaction"]);
  });

  it("mentionedIdents drops short and stop words", () => {
    expect([...mentionedIdents("fix the compaction threshold in a.ts")].sort()).toEqual(["compaction", "threshold"]);
  });

  it("fitToBudget keeps the largest prefix that fits", () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ file: `src/f${i}.ts`, tag: { name: `n${i}`, line: 1, text: `export const n${i} = ${i};` } }));
    const text = fitToBudget(entries, 200);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.startsWith("src/f0.ts:")).toBe(true);
  });
});

describe("buildRepoMap on a fixture repository", () => {
  let repo: string;
  let cacheDir: string;
  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-r7-"));
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-r7-cache-"));
    const files: Record<string, string> = {
      "src/context/compaction.ts": "export const COMPACT_THRESHOLD = 40;\nexport function shouldCompact(messages: string[]): boolean {\n  return messages.length > COMPACT_THRESHOLD;\n}\n",
      "src/chat.ts": 'import { shouldCompact } from "./context/compaction";\nexport function sendChat(history: string[]) {\n  return shouldCompact(history) ? formatTitle("x") : null;\n}\nimport { formatTitle } from "./util/strings";\n',
      "src/util/strings.ts": "export function formatTitle(title: string): string {\n  return title.trim();\n}\nexport function slugify(text: string): string {\n  return text.toLowerCase();\n}\n",
      "src/ui/Button.tsx": 'import { formatTitle } from "../util/strings";\nexport function Button(props: { label: string }) {\n  return <button>{formatTitle(props.label)}</button>;\n}\n',
      "src/ui/Page.tsx": 'import { Button } from "./Button";\nexport function Page() {\n  return <main><Button label="a" /></main>;\n}\n',
      "src/server/routes.ts": 'import { sendChat } from "../chat";\nexport function registerRoutes() {\n  return sendChat([]);\n}\n',
      "README.md": "# fixture\n",
    };
    for (const [file, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
      await fs.writeFile(path.join(repo, file), content);
    }
    execFileSync("git", ["init", "-q"], { cwd: repo });
  });
  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it("ranks the file the request names first and stays within the budget", async () => {
    clearRepoMapMemory();
    const result = await buildRepoMap(repo, { query: "fix compaction threshold", cacheDir, maxChars: 400 });
    expect(result).not.toBeNull();
    expect(result!.rankedFiles[0]).toBe("src/context/compaction.ts");
    expect(result!.map.length).toBeLessThanOrEqual(400);
    expect(result!.map).toContain("src/context/compaction.ts:\n│export const COMPACT_THRESHOLD = 40;");
    // A different request re-ranks the same files.
    const ui = await buildRepoMap(repo, { query: "change the Button label", cacheDir, mentionedFiles: ["src/ui/Button.tsx"] });
    expect(ui!.rankedFiles[0]).toBe("src/ui/Button.tsx");
  });

  it("a second run hits the cache and finishes in under 200 ms; an edited file is re-read", async () => {
    clearRepoMapMemory();
    await buildRepoMap(repo, { query: "fix compaction threshold", cacheDir });
    const started = Date.now();
    const again = await buildRepoMap(repo, { query: "fix compaction threshold", cacheDir });
    expect(Date.now() - started).toBeLessThan(200);
    expect(again!.fromCache).toBe(true);

    // From the disk cache too (a new worker process).
    clearRepoMapMemory();
    const disk = await buildRepoMap(repo, { query: "fix compaction threshold", cacheDir });
    expect(disk!.fromCache).toBe(true);

    const file = path.join(repo, "src/util/strings.ts");
    await fs.appendFile(file, "export function shout(text: string): string {\n  return text.toUpperCase();\n}\n");
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(file, later, later);
    const edited = await buildRepoMap(repo, { query: "add shout to strings", cacheDir, maxChars: 4_000 });
    expect(edited!.fromCache).toBe(false);
    expect(edited!.map).toContain("export function shout(text: string): string");
  });

  it("exploreRepository swaps the flat listing for the map when given the request", async () => {
    const withMap = await exploreRepository(repo, { query: "fix compaction threshold", fileHint: null });
    expect(withMap.context.startsWith("Repository map (files ranked by relevance")).toBe(true);
    expect(withMap.context).toContain("--- src/context/compaction.ts ---");
    const legacy = await exploreRepository(repo, { fileHint: null });
    expect(legacy.context.startsWith("Workspace files:")).toBe(true);
  });

  it("a repository without TS/JS falls back to the flat listing", async () => {
    const py = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-r7-py-"));
    try {
      await fs.writeFile(path.join(py, "main.py"), "def main():\n    pass\n");
      await fs.writeFile(path.join(py, "README.md"), "# py\n");
      expect(await buildRepoMap(py, { query: "fix main", cacheDir })).toBeNull();
      const explored = await exploreRepository(py, { query: "fix main" });
      expect(explored.context.startsWith("Workspace files:")).toBe(true);
    } finally {
      await fs.rm(py, { recursive: true, force: true });
    }
  });

  it("the planner prompt carries the map", () => {
    const prompt = planningPrompt({
      command: "fix compaction threshold",
      classification: { kind: "code_change", complexity: "low", reasons: ["edit"], suggestedCapabilities: ["backend-development"] } as never,
      policy: { maxReplans: 1, maxSubtasks: 4 },
      capabilityList: "- Backend",
      repoMap: "src/context/compaction.ts:\n│export const COMPACT_THRESHOLD = 40;",
    });
    expect(prompt).toContain("Repository map (source files ranked by relevance to this request");
    expect(prompt).toContain("│export const COMPACT_THRESHOLD = 40;");
  });
});

describe("buildRepoMap on the Fhara repository itself", () => {
  it("ranks context/compaction.ts in the top 5 for 'fix compaction threshold'", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-r7-self-"));
    try {
      clearRepoMapMemory();
      const root = path.resolve(__dirname, "../../..");
      const result = await buildRepoMap(root, { query: "fix compaction threshold", cacheDir, maxParseMs: 100_000 });
      expect(result).not.toBeNull();
      expect(result!.rankedFiles.slice(0, 5)).toContain("packages/worker/src/context/compaction.ts");
      expect(result!.map.length).toBeLessThanOrEqual(4_000);
      const again = await buildRepoMap(root, { query: "fix compaction threshold", cacheDir });
      expect(again!.fromCache).toBe(true);
    } finally {
      clearRepoMapMemory();
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  }, 90_000);
});
