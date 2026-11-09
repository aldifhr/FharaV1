import { concernCategory } from "./classifier";
import { routeCapability } from "./capabilities";
import { CAPABILITY, type AgentDefinition, type Classification, type Concern, type ExecutionPlan, type PlanSubtask } from "./types";

/**
 * Per-concern planning for high/ultra changes (e2e ULTRA).
 *
 * A slow model cannot produce "dark mode + header refactor + tests +
 * README" as ONE full-file JSON answer inside a subtask timeout: the call
 * either times out or the answer is truncated into invalid JSON. Each
 * concern (or file group) becomes its own code_change node instead, run in
 * request order (they usually touch the same files), so every LLM call
 * stays small and a failure costs one concern, not the whole change.
 */

const CATEGORY_PATTERN: Record<Concern["category"], RegExp> = {
  tests: /\b(tests?|testing|unit[- ]?tests?|specs?|vitest|jest|playwright|coverage|uji|pengujian)\b/i,
  docs: /\b(readme|docs?|documentation|dokumentasi|changelog|guide|panduan)\b/i,
  theme: /\b(dark ?mode|light ?mode|mode gelap|mode terang|themes?|tema|toggle)\b/i,
  refactor: /\b(refactor|refaktor|extract|komponen terpisah|separate component|split|pisah\w*|restructure)\b/i,
  style: /\b(css|styles?|styling|tampilan|warna|colou?rs?|font)\b/i,
  change: /$^/,
};

const DOC_PATHS = ["README.md", "docs/"];

/** Concern categories of the request that a node's title/description covers. */
export function coveredConcerns(node: Pick<PlanSubtask, "title" | "description">, concerns: Concern[]): Concern[] {
  const text = `${node.title}\n${node.description}`;
  return concerns.filter((concern) => concern.category !== "change" && CATEGORY_PATTERN[concern.category].test(text));
}

function uniqueKey(base: string, used: Set<string>): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "part";
  let key = slug;
  let index = 2;
  while (used.has(key)) key = `${slug}-${index++}`;
  used.add(key);
  return key;
}

function docsCapability(original: string, agents: AgentDefinition[] | undefined): string {
  if (!agents) return original;
  return routeCapability(CAPABILITY.DOCUMENTATION, agents, { allowFallback: false }) ? CAPABILITY.DOCUMENTATION : original;
}

/** Replace node `key` with `parts` (sequential), rewiring every dependent to the last part. */
function replaceNode(plan: ExecutionPlan, key: string, parts: PlanSubtask[]): ExecutionPlan {
  const partKeys = parts.map((part) => part.key);
  const subtasks: PlanSubtask[] = [];
  for (const subtask of plan.subtasks) {
    if (subtask.key === key) {
      subtasks.push(...parts);
      continue;
    }
    subtasks.push({
      ...subtask,
      // A dependent of the split node waits for ALL of its parts.
      dependencies: Array.from(
        new Set(subtask.dependencies.flatMap((dependency) => (dependency === key ? partKeys : [dependency])))
      ),
    });
  }
  return {
    ...plan,
    strategy: subtasks.length > 1 ? "dag" : plan.strategy,
    subtasks: subtasks.map((subtask, index) => ({ ...subtask, order: index })),
  };
}

function splitByConcerns(node: PlanSubtask, concerns: Concern[], used: Set<string>, agents?: AgentDefinition[]): PlanSubtask[] {
  const parts: PlanSubtask[] = [];
  let previous: string[] = node.dependencies;
  for (const concern of concerns) {
    const key = uniqueKey(`${node.key}-${concern.category}`, used);
    const isDocs = concern.category === "docs";
    const isTests = concern.category === "tests";
    const allowedPaths = node.allowedPaths && node.allowedPaths.length > 0
      ? isDocs
        ? Array.from(new Set([...DOC_PATHS]))
        : isTests
          // Test files usually live outside the component scope.
          ? undefined
          : node.allowedPaths
      : node.allowedPaths;
    parts.push({
      key,
      title: `${node.title} — ${concern.category}`,
      description: `${concern.text}. This subtask covers ONLY this part of the request (${concern.category}); the other parts (${concerns
        .filter((other) => other !== concern)
        .map((other) => other.category)
        .join(", ")}) are separate subtasks. Context: ${node.description}`,
      kind: "code_change",
      capability: isDocs ? docsCapability(node.capability, agents) : node.capability,
      dependencies: previous,
      order: node.order,
      ...(allowedPaths ? { allowedPaths } : {}),
      ...(node.origin ? { origin: node.origin } : {}),
    });
    previous = [key];
  }
  return parts;
}

function splitByPaths(node: PlanSubtask, used: Set<string>): PlanSubtask[] {
  const paths = node.allowedPaths ?? [];
  const parts: PlanSubtask[] = [];
  let previous: string[] = node.dependencies;
  for (const path of paths) {
    const key = uniqueKey(`${node.key}-${path.replace(/\/$/, "").split("/").pop() ?? "part"}`, used);
    parts.push({
      key,
      title: `${node.title} — ${path}`,
      description: `${node.description}\nLimit this step to ${path}; the other files of this change are separate subtasks.`,
      kind: "code_change",
      capability: node.capability,
      dependencies: previous,
      order: node.order,
      allowedPaths: [path],
      ...(node.origin ? { origin: node.origin } : {}),
    });
    previous = [key];
  }
  return parts;
}

/**
 * For high/ultra requests: every code_change node that covers two or more
 * of the request's concerns is split into one node per concern. Bounded by
 * `maxSubtasks` (a split that would exceed it is skipped).
 */
export function splitMultiConcernNodes(
  plan: ExecutionPlan,
  classification: Pick<Classification, "complexity" | "concerns">,
  options: { maxSubtasks: number; agents?: AgentDefinition[] }
): { plan: ExecutionPlan; split: string[] } {
  if (classification.complexity !== "high" && classification.complexity !== "ultra") return { plan, split: [] };
  const concerns = classification.concerns ?? [];
  if (concerns.length < 2) return { plan, split: [] };
  let current = plan;
  const split: string[] = [];
  const used = new Set(plan.subtasks.map((subtask) => subtask.key));
  for (const original of plan.subtasks) {
    // Read the node from the CURRENT plan: an earlier split may have
    // rewired its dependencies.
    const node = current.subtasks.find((subtask) => subtask.key === original.key) ?? original;
    if (node.kind !== "code_change") continue;
    const covered = coveredConcerns(node, concerns);
    if (covered.length < 2) continue;
    if (current.subtasks.length - 1 + covered.length > options.maxSubtasks) continue;
    current = replaceNode(current, node.key, splitByConcerns(node, covered, used, options.agents));
    split.push(node.key);
  }
  return { plan: current, split };
}

/** Subtask keys whose failure was a subtask timeout ("key (attempt n): Subtask timed out …"). */
export function timedOutKeys(failureSummary: string): string[] {
  const keys = new Set<string>();
  for (const match of failureSummary.matchAll(/([A-Za-z0-9_.-]+) \(attempt \d+\): Subtask timed out/g)) keys.add(match[1]);
  return Array.from(keys);
}

/**
 * After a timeout, the replan must not retry the same oversized node: a
 * node of the new plan that is the timed-out node (same key, or same
 * description) is split into smaller nodes — per concern when it covers
 * several, else per declared file/directory. A node that cannot be split
 * is left as is (the caller logs that).
 */
export function splitTimedOutNodes(
  plan: ExecutionPlan,
  previousPlan: ExecutionPlan,
  timedOut: string[],
  classification: Pick<Classification, "concerns">,
  options: { maxSubtasks: number; agents?: AgentDefinition[] }
): { plan: ExecutionPlan; split: string[]; unsplittable: string[] } {
  if (timedOut.length === 0) return { plan, split: [], unsplittable: [] };
  const previous = previousPlan.subtasks.filter((subtask) => timedOut.includes(subtask.key));
  const concerns = classification.concerns ?? [];
  let current = plan;
  const split: string[] = [];
  const unsplittable: string[] = [];
  const used = new Set(plan.subtasks.map((subtask) => subtask.key));
  for (const original of plan.subtasks) {
    const node = current.subtasks.find((subtask) => subtask.key === original.key) ?? original;
    if (node.kind !== "code_change") continue;
    const matches =
      timedOut.includes(node.key) ||
      previous.some((old) => old.description.trim() === node.description.trim() || old.title.trim() === node.title.trim());
    if (!matches) continue;
    // Concerns the node covers; when the request had none (single
    // concern), fall back to the node's own wording.
    const covered = coveredConcerns(node, concerns.length > 0 ? concerns : [{ category: concernCategory(node.description), text: node.description }]);
    let parts: PlanSubtask[] = [];
    if (covered.length >= 2) parts = splitByConcerns(node, covered, used, options.agents);
    else if ((node.allowedPaths?.length ?? 0) >= 2) parts = splitByPaths(node, used);
    if (parts.length < 2 || current.subtasks.length - 1 + parts.length > options.maxSubtasks) {
      unsplittable.push(node.key);
      continue;
    }
    current = replaceNode(current, node.key, parts);
    split.push(node.key);
  }
  return { plan: current, split, unsplittable };
}
