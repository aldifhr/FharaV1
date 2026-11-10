import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Architecture guard: the worker's source tree is layered, and a module may
 * import only from its own layer or a LOWER one (type-only imports count).
 *
 *   0 foundation   types/ prompts/ utils/
 *   1 infra        llm/ effects/ governance/ context/ workerApi convexClient (+ @/api)
 *   2 tools        tools/ (git, fs, process, browser) mcp/
 *   3 execution    execution/
 *   4 orchestrator orchestrator/ scheduler/ router/
 *   5 services     services/ (task lifecycle: taskRunner + runner/)
 *   6 entry        index
 *
 * i.e. tools ← execution ← orchestrator ← services. A new top-level
 * directory must be added to LAYERS before it can be imported.
 *
 * Pure shared modules from apps/api (no Convex/Node/DOM APIs) listed in
 * SHARED_FOUNDATION count as foundation, so utils/ may read the shared role
 * registry.
 */
const LAYERS: Record<string, number> = {
  types: 0,
  prompts: 0,
  utils: 0,
  llm: 1,
  effects: 1,
  governance: 1,
  context: 1,
  workerApi: 1,
  convexClient: 1,
  "@api": 1,
  // Vendored third-party code (threadbear safe-git): infra, imports only @api.
  vendor: 1,
  tools: 2,
  mcp: 2,
  execution: 3,
  orchestrator: 4,
  scheduler: 4,
  router: 4,
  services: 5,
  index: 6,
};

/** apps/api modules that are pure TypeScript and safe at the foundation layer. */
const SHARED_FOUNDATION = new Set([
  "convex/lib/roles",
  // Skill v2: pure skill prompt helpers (PromptSkill type, budgets).
  "convex/lib/skills",
  // Pure shared helpers (no Convex APIs): plan validation + estimate +
  // plan-review policy run on both sides.
  "convex/lib/ownershipPaths",
  "convex/lib/planValidation",
  "convex/lib/estimate",
  "convex/lib/planReviewPolicy",
  // Plan 022: contract / gates / escalation and model tiers (pure).
  "convex/lib/subtaskContract",
  "convex/lib/modelTiers",
  // Plan 025: requirements traceability and execution observations (pure).
  "convex/lib/requirements",
  "convex/lib/observations",
  // Plan 027: agent performance scoring (pure). The model capability
  // registry was removed with plan 033.
  "convex/lib/agentPerformance",
  // Plan 032: the global LLM selection mode (pure).
  "convex/lib/llmSelection",
]);

const SRC = path.resolve(import.meta.dirname, "../src");

function listSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSources(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Top-level unit of a src-relative path: its first directory, or the file stem. */
function unitOf(relative: string): string {
  const [first, ...rest] = relative.split("/");
  return rest.length > 0 ? first : first.replace(/\.ts$/, "");
}

/** The layer unit an import specifier resolves to, or null for packages. */
function targetUnit(fromRelative: string, specifier: string): string | null {
  if (specifier.startsWith("@/api/") || specifier.startsWith("@api/")) {
    const apiPath = specifier.replace(/^@\/?api\//, "").replace(/\.ts$/, "");
    return SHARED_FOUNDATION.has(apiPath) ? "types" : "@api";
  }
  if (specifier.startsWith("@/")) return unitOf(specifier.slice(2));
  if (specifier.startsWith(".")) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromRelative), specifier));
    return unitOf(resolved.endsWith(".ts") ? resolved : `${resolved}.ts`);
  }
  return null;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) out.push(match[1] ?? match[2]);
  return out;
}

describe("worker layering", () => {
  const files = listSources(SRC).map((file) => path.relative(SRC, file).split(path.sep).join("/"));

  it("classifies every top-level source unit", () => {
    const unknown = [...new Set(files.map(unitOf))].filter((unit) => !(unit in LAYERS));
    expect(unknown).toEqual([]);
  });

  it("has no upward imports (tools ← execution ← orchestrator ← services)", () => {
    const violations: string[] = [];
    for (const file of files) {
      const from = unitOf(file);
      const source = fs.readFileSync(path.join(SRC, file), "utf-8");
      for (const specifier of importsOf(source)) {
        const to = targetUnit(file, specifier);
        if (to === null) continue;
        if (!(to in LAYERS)) {
          violations.push(`${file} → ${specifier} (unclassified unit "${to}")`);
          continue;
        }
        if (LAYERS[to] > LAYERS[from]) {
          violations.push(`${file} (${from}, L${LAYERS[from]}) → ${specifier} (${to}, L${LAYERS[to]})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("detects an upward import (self-check of the scanner)", () => {
    expect(targetUnit("execution/x.ts", "@/orchestrator/budget")).toBe("orchestrator");
    expect(targetUnit("execution/x.ts", "../orchestrator/types")).toBe("orchestrator");
    expect(targetUnit("services/runner/a.ts", "./types")).toBe("services");
    expect(targetUnit("utils/x.ts", "@/api/convex/lib/roles")).toBe("types");
    expect(targetUnit("utils/x.ts", "@/api/convex/_generated/api")).toBe("@api");
    expect(importsOf('import type { A } from "@/types";\nexport { b } from "./b";')).toEqual(["@/types", "./b"]);
  });
});
