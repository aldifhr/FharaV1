/**
 * Executor escalation (plan 022). When a code_change meets a decision it
 * must not take alone it STOPS and returns `status: "escalated"` instead
 * of expanding scope. Two sources:
 *
 *  - the model asked: an `escalation` object in its answer
 *    ({"files":[],"escalation":{"kind":"new_dependency","reason":"..."}});
 *  - the runner detected it from the proposed files: a file outside the
 *    subtask's scope (allowedPaths), a schema/migration file that is not
 *    explicitly in scope, or a new package.json dependency the subtask
 *    does not name.
 *
 * Escalated outcomes travel as a failed NodeOutcome whose error starts
 * with "Escalated (" (permanent: never blindly retried) and whose meta
 * carries the escalation; the runner routes it (services/runner/escalation).
 */
import * as fs from "node:fs/promises";
import { parseEscalation, type Escalation } from "@/api/convex/lib/subtaskContract";
import { isPathWithinOwnership } from "@/utils/ownershipPaths";
import { resolveSandboxPath } from "@/tools/sandbox";
import type { PlanSubtask } from "@/types";

export const ESCALATED_ERROR_PREFIX = "Escalated (";

/** The error text of an escalated outcome. */
export function escalatedError(escalation: Escalation): string {
  return `${ESCALATED_ERROR_PREFIX}${escalation.kind}): ${escalation.reason}${
    escalation.detail ? ` [${escalation.detail}]` : ""
  }`;
}

export function isEscalatedError(error: string | undefined): boolean {
  return typeof error === "string" && error.startsWith(ESCALATED_ERROR_PREFIX);
}

/** Every top-level-balanced JSON object in `content`, in order. */
function* jsonObjects(content: string): Generator<Record<string, unknown>> {
  for (let start = content.indexOf("{"); start >= 0; start = content.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < content.length; index++) {
      const char = content[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(content.slice(start, index + 1));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              yield parsed as Record<string, unknown>;
            }
          } catch {
            // not JSON; keep scanning
          }
          break;
        }
      }
    }
  }
}

/** The escalation the model put in its answer, if any (JSON or a trailing JSON object). */
export function escalationFromAnswer(content: string): Escalation | null {
  if (!content.includes("escalation")) return null;
  for (const object of jsonObjects(content)) {
    if ("escalation" in object) {
      const parsed = parseEscalation(object.escalation);
      if (parsed) return parsed;
    }
  }
  return null;
}

const SCHEMA_FILE = /(^|\/)(schema\.(ts|js|prisma|sql|graphql)|[^/]+\.prisma|migrations?\/[^/]+)$/i;

/** True when `filePath` is named explicitly (file, not a directory) in the scope. */
function explicitlyInScope(filePath: string, allowedPaths: string[] | undefined): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return (allowedPaths ?? []).some((entry) => entry.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "") === normalized);
}

function depsOf(json: unknown): Set<string> {
  const names = new Set<string>();
  if (!json || typeof json !== "object") return names;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const block = (json as Record<string, unknown>)[field];
    if (block && typeof block === "object") for (const name of Object.keys(block)) names.add(name);
  }
  return names;
}

function parseJson(text: string | null): unknown {
  if (text === null) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Detect an escalation from the proposed files before anything is staged.
 * `currentContent` returns the file's current (staged or disk) content.
 * Returns null when the change stays inside its contract.
 */
export async function detectEscalation(input: {
  subtask: Pick<PlanSubtask, "key" | "title" | "description" | "allowedPaths" | "objective">;
  files: Array<{ filePath: string; newContent: string }>;
  currentContent: (filePath: string) => Promise<string | null>;
  /** Allowed by the CTO / the user earlier in this task (kind + detail). */
  allowed?: Array<{ kind: string; detail?: string }>;
}): Promise<Escalation | null> {
  const { subtask } = input;
  const isAllowed = (kind: string, detail: string) =>
    (input.allowed ?? []).some(
      (entry) =>
        entry.kind === kind &&
        (!entry.detail || entry.detail.split(/,\s*/).some((part) => detail.split(/,\s*/).includes(part)))
    );
  for (const file of input.files) {
    if (!isPathWithinOwnership(file.filePath, subtask.allowedPaths)) {
      return {
        kind: "out_of_scope",
        reason: `Refusing to modify path outside declared ownership: ${file.filePath} (scope: ${(subtask.allowedPaths ?? []).join(", ")})`,
        detail: file.filePath,
        source: "detected",
      };
    }
  }
  for (const file of input.files) {
    if (
      SCHEMA_FILE.test(file.filePath) &&
      !explicitlyInScope(file.filePath, subtask.allowedPaths) &&
      !isAllowed("schema_change", file.filePath)
    ) {
      return {
        kind: "schema_change",
        reason: `The change edits the schema/migration file ${file.filePath}, which this subtask's scope does not list explicitly`,
        detail: file.filePath,
        source: "detected",
      };
    }
  }
  const subtaskText = `${subtask.title}\n${subtask.description}\n${subtask.objective ?? ""}`.toLowerCase();
  for (const file of input.files) {
    if (!/(^|\/)package\.json$/.test(file.filePath)) continue;
    const before = depsOf(parseJson(await input.currentContent(file.filePath)));
    const after = depsOf(parseJson(file.newContent));
    const added = [...after].filter(
      (name) => !before.has(name) && !subtaskText.includes(name.toLowerCase()) && !isAllowed("new_dependency", name)
    );
    if (added.length > 0) {
      return {
        kind: "new_dependency",
        reason: `The change adds ${added.length === 1 ? "a dependency" : "dependencies"} the subtask does not name: ${added.join(", ")}`,
        detail: added.join(", "),
        source: "detected",
      };
    }
  }
  return null;
}

/** Current content for detection: the staged edit when there is one, else disk. */
export function contentReader(
  workspacePath: string,
  staged: (filePath: string) => { newContent?: string | null; changeType?: string } | undefined
): (filePath: string) => Promise<string | null> {
  return async (filePath) => {
    const change = staged(filePath);
    if (change && change.changeType !== "deleted" && typeof change.newContent === "string") return change.newContent;
    try {
      return await fs.readFile(resolveSandboxPath(workspacePath, filePath), "utf8");
    } catch {
      return null;
    }
  };
}
