import { concernCategory } from "./classifier";
import { type AgentDefinition, type Classification, type Concern, type ExecutionPlan, type PlanSubtask } from "@/types";

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

function isWordChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    ch === "_"
  );
}

function tokenizeLower(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  let start = -1;
  for (let i = 0; i < lower.length; i++) {
    if (isWordChar(lower[i])) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      tokens.push(lower.slice(start, i));
      start = -1;
    }
  }
  if (start !== -1) tokens.push(lower.slice(start));
  return tokens;
}

function hasAnyWord(tokens: ReadonlySet<string>, words: readonly string[], prefixes: readonly string[] = []): boolean {
  for (const w of words) {
    if (tokens.has(w)) return true;
  }
  if (prefixes.length > 0) {
    for (const token of tokens) {
      for (const prefix of prefixes) {
        if (token.startsWith(prefix)) return true;
      }
    }
  }
  return false;
}

function hasAnyPhrase(lower: string, phrases: readonly string[]): boolean {
  for (const phrase of phrases) {
    let idx = lower.indexOf(phrase);
    while (idx !== -1) {
      const beforeOk = idx === 0 || !isWordChar(lower[idx - 1]);
      const afterIdx = idx + phrase.length;
      const afterOk = afterIdx >= lower.length || !isWordChar(lower[afterIdx]);
      if (beforeOk && afterOk) return true;
      idx = lower.indexOf(phrase, idx + 1);
    }
  }
  return false;
}

const CATEGORY_MATCHERS: Record<Concern["category"], (lower: string, tokens: ReadonlySet<string>) => boolean> = {
  tests: (lower, tokens) =>
    hasAnyWord(tokens, ["test", "tests", "testing", "spec", "specs", "vitest", "jest", "playwright", "coverage", "uji", "pengujian"]) ||
    hasAnyPhrase(lower, ["unit test", "unit tests", "unit-test", "unit-tests"]),
  docs: (_lower, tokens) =>
    hasAnyWord(tokens, ["readme", "doc", "docs", "documentation", "dokumentasi", "changelog", "guide", "panduan"]),
  theme: (lower, tokens) =>
    hasAnyWord(tokens, ["darkmode", "lightmode", "theme", "themes", "tema", "toggle"]) ||
    hasAnyPhrase(lower, ["dark mode", "light mode", "mode gelap", "mode terang"]),
  refactor: (lower, tokens) =>
    hasAnyWord(tokens, ["refactor", "refaktor", "extract", "split", "restructure"], ["pisah"]) ||
    hasAnyPhrase(lower, ["komponen terpisah", "separate component"]),
  style: (_lower, tokens) =>
    hasAnyWord(tokens, ["css", "style", "styles", "styling", "tampilan", "warna", "color", "colors", "colour", "colours", "font"]),
  change: () => false,
};

const DOC_PATHS = ["README.md", "docs/"];

/** Concern categories of the request that a node's title/description covers. */
export function coveredConcerns(node: Pick<PlanSubtask, "title" | "description">, concerns: Concern[]): Concern[] {
  const lower = `${node.title}\n${node.description}`.toLowerCase();
  const tokens = new Set(tokenizeLower(lower));
  return concerns.filter((concern) => concern.category !== "change" && CATEGORY_MATCHERS[concern.category](lower, tokens));
}

function slugifyAscii(base: string): string {
  const lower = base.toLowerCase();
  let out = "";
  let prevDash = true;
  for (let i = 0; i < lower.length && out.length < 40; i++) {
    const code = lower.charCodeAt(i);
    const isAlnum = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
    if (isAlnum) {
      out += lower[i];
      prevDash = false;
    } else if (!prevDash) {
      out += "-";
      prevDash = true;
    }
  }
  while (out.endsWith("-")) out = out.slice(0, -1);
  return out || "part";
}

function uniqueKey(base: string, used: Set<string>): string {
  const slug = slugifyAscii(base);
  let key = slug;
  let index = 2;
  while (used.has(key)) key = `${slug}-${index++}`;
  used.add(key);
  return key;
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

function splitByConcerns(node: PlanSubtask, concerns: Concern[], used: Set<string>): PlanSubtask[] {
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
      // The docs part of a code-affecting multi-concern request stays with the
      // implementer (user decision 2026-11-11): pure-docs requests are not
      // split. Its paths are still docs-only.
      capability: node.capability,
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
    const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
    const leaf = trimmed.split("/").pop() ?? "part";
    const key = uniqueKey(`${node.key}-${leaf}`, used);
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
 * `maxSubtasks` (if the full split would exceed it, splits as many as fit).
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
    const room = options.maxSubtasks - current.subtasks.length + 1;
    if (room < 2) continue;
    const toSplit =
      covered.length <= room
        ? covered
        : [
            ...covered.slice(0, room - 1),
            {
              category: covered[room - 1].category,
              text: covered
                .slice(room - 1)
                .map((c) => c.text)
                .join("; "),
            },
          ];
    current = replaceNode(current, node.key, splitByConcerns(node, toSplit, used));
    split.push(node.key);
  }
  return { plan: current, split };
}

function isKeyChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    ch === "_" ||
    ch === "." ||
    ch === "-"
  );
}

/** Subtask keys whose failure was a subtask timeout ("key (attempt n): Subtask timed out …"). */
export function timedOutKeys(failureSummary: string): string[] {
  const keys = new Set<string>();
  const marker = "): Subtask timed out";
  let pos = 0;
  while (pos < failureSummary.length) {
    const endIdx = failureSummary.indexOf(marker, pos);
    if (endIdx === -1) break;
    const attemptIdx = failureSummary.lastIndexOf(" (attempt ", endIdx);
    if (attemptIdx > 0) {
      const digits = failureSummary.slice(attemptIdx + " (attempt ".length, endIdx);
      const allDigits = digits.length > 0 && [...digits].every((c) => c >= "0" && c <= "9");
      if (allDigits) {
        let start = attemptIdx - 1;
        while (start >= 0 && isKeyChar(failureSummary[start])) start--;
        const key = failureSummary.slice(start + 1, attemptIdx);
        if (key.length > 0) keys.add(key);
      }
    }
    pos = endIdx + marker.length;
  }
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
    if (covered.length >= 2) parts = splitByConcerns(node, covered, used);
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
