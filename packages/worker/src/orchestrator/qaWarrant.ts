import { CAPABILITY, type ExecutionPlan } from "@/types";
import { normalizeCapability } from "./capabilities";

const UI_CAPABILITIES = new Set<string>([CAPABILITY.FRONTEND, CAPABILITY.DESIGN]);
const UI_PATH = /(\.(tsx|jsx|vue|svelte|astro|html|css|scss|sass|less)\b|(^|\/)(app|pages|components|styles|public)(\/|$))/i;

/** Explicit browser-QA request. Plain "unit tests" does NOT count. */
export const BROWSER_QA_REQUESTED =
  /(@qa\b|\bqa\b|\be2e\b|end[- ]to[- ]end|playwright|browser[- ]?(test|testing|check|qa)|(test|verify|check)\s+(it\s+)?in\s+(the\s+)?browser|smoke[- ]?test)/i;

/**
 * True when browser QA is warranted under qaMode=auto: a code change that
 * touches UI (frontend/design capability, or UI-ish allowedPaths) or an
 * explicit browser-QA request. Runtime gates (changes applied, project
 * browser-runnable) are enforced by the QA stage itself.
 */
export function qaWarranted(plan: ExecutionPlan, command: string): boolean {
  const codeChanges = plan.subtasks.filter((s) => s.kind === "code_change");
  if (codeChanges.length === 0) return false;
  if (BROWSER_QA_REQUESTED.test(command)) return true;
  return codeChanges.some(
    (s) =>
      UI_CAPABILITIES.has(normalizeCapability(s.capability)) ||
      (s.allowedPaths ?? []).some((p) => UI_PATH.test(p))
  );
}
