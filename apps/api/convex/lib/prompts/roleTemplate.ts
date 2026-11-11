/**
 * Role prompt templates as agent instructions: which template a role uses,
 * whether a stored prompt is an unedited seed, and the create-form prefill.
 * Pure — imported by Convex (sync, reset), the web app and tests.
 */
import { LEGACY_ROLE_SUCCESSORS, ROLES, ROLE_KEYS, isRoleKey, normalizeRoleKey, type RoleKey } from "../roles";
import { AGENT_SEED_PROMPTS, PREVIOUS_SEED_PROMPTS } from "./agents";

/** The current role key for a stored role ("UI/UX" → designer), or null for a custom role. */
export function templateRoleKey(role: string | undefined): RoleKey | null {
  const raw = normalizeRoleKey(role);
  const key: string = LEGACY_ROLE_SUCCESSORS[raw] ?? raw;
  if (isRoleKey(key)) return key;
  return ROLE_KEYS.find((k) => ROLES[k].label.toLowerCase() === raw) ?? null;
}

/** The role's prompt template, or null for a custom role. */
export function roleTemplateFor(role: string | undefined): string | null {
  const key = templateRoleKey(role);
  return key ? AGENT_SEED_PROMPTS[ROLES[key].defaultPromptKey] : null;
}

/**
 * Whether `prompt` is a seed the user never edited: the role's current
 * template or one of its earlier seeds (surrounding blank space ignored).
 * Only such prompts follow a new template on sync; edited ones never do.
 */
export function isUneditedSeed(role: string | undefined, prompt: string | undefined): boolean {
  const text = (prompt ?? "").trim();
  const key = templateRoleKey(role);
  if (!text || !key) return false;
  return text === AGENT_SEED_PROMPTS[key].trim() || (PREVIOUS_SEED_PROMPTS[key] ?? []).some((p) => p.trim() === text);
}

/** Whether `prompt` is any role's template or earlier seed (or empty). */
function isAnySeed(prompt: string): boolean {
  const text = prompt.trim();
  return !text || ROLE_KEYS.some((key) => isUneditedSeed(key, text));
}

/**
 * The create form's instructions after the user picks `nextRole`: the
 * role's template, unless the user already typed their own text, which is
 * kept. A custom role keeps whatever is there.
 */
export function prefillPromptForRole(current: string, nextRole: string | null | undefined): string {
  if (!isAnySeed(current)) return current;
  return (nextRole ? roleTemplateFor(nextRole) : null) ?? "";
}
