/**
 * Skill loading at run time (pure: no Convex, Node or DOM APIs).
 *
 * Shared by the worker (task runs) and the Convex chat action (chat
 * replies). An agent's `skillLoading` decides how its library skills reach
 * the model:
 *  - inline: `formatSkillsSection` (lib/skills.ts), unchanged behaviour.
 *  - on_demand: only a short index (name + description + size) goes into
 *    the prompt, and the agent calls the read-only `load_skill` tool to
 *    read one skill's full, untrimmed text. Each call is capped at
 *    LOAD_SKILL_MAX_CHARS and each run at LOAD_SKILL_MAX_CALLS.
 *
 * The loader only returns text the agent was already given (its own
 * attached skills). It never grants a tool or a permission.
 */
import {
  DEFAULT_SKILL_LOADING,
  formatSkillsSection,
  LOAD_SKILL_MAX_CALLS,
  LOAD_SKILL_MAX_CHARS,
  LOAD_SKILL_TOOL,
  SKILLS_INDEX_BUDGET,
  SKILLS_PROMPT_BUDGET,
  type PromptSkill,
  type SkillLoadingMode,
} from "./skills";

export function normalizeSkillLoading(value: unknown): SkillLoadingMode {
  return value === "on_demand" ? "on_demand" : DEFAULT_SKILL_LOADING;
}

function fullText(skill: PromptSkill): string {
  return (skill.fullInstructions ?? skill.instructions).trim();
}

/**
 * The on-demand index: one line per skill, within `budget` chars. Skills
 * that do not fit are still loadable; the index says how many were left out.
 */
export function formatSkillsIndex(
  skills: readonly PromptSkill[] | undefined,
  budget: number = SKILLS_INDEX_BUDGET
): string {
  const usable = (skills ?? []).filter((s) => s.name.trim() && fullText(s));
  if (usable.length === 0) return "";
  const head = [
    "## Skills (load on demand)",
    `These skills are available to you, but their text is not in this prompt. When a skill fits the work, read it first with the ${LOAD_SKILL_TOOL} tool, by exact name. Load only what you need (at most ${LOAD_SKILL_MAX_CALLS} per run).`,
  ].join("\n");
  const lines: string[] = [];
  let used = head.length;
  let omitted = 0;
  for (const skill of usable) {
    const desc = (skill.description ?? "").replace(/\s+/g, " ").trim();
    const size = fullText(skill).length;
    const line = `- ${skill.name.trim()}${desc ? `: ${desc}` : ""} (${size.toLocaleString("en-US")} chars)`;
    if (used + 1 + line.length > budget) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    used += 1 + line.length;
  }
  if (omitted > 0) lines.push(`- …and ${omitted} more (load by name)`);
  return [head, ...lines].join("\n");
}

/**
 * The skills section for an agent prompt in either mode. Inline mode is
 * exactly `formatSkillsSection` (the 12k budget, cut + dropped as before).
 */
export function skillsSectionFor(
  skills: readonly PromptSkill[] | undefined,
  mode: SkillLoadingMode | undefined,
  budget: number = SKILLS_PROMPT_BUDGET
): string {
  return normalizeSkillLoading(mode) === "on_demand" ? formatSkillsIndex(skills) : formatSkillsSection(skills, budget);
}

/** Static system prompt first, then the skills section in the agent's mode. */
export function appendAgentSkills(
  systemPrompt: string | undefined,
  skills: readonly PromptSkill[] | undefined,
  mode: SkillLoadingMode | undefined
): string | undefined {
  const section = skillsSectionFor(skills, mode);
  if (!section) return systemPrompt;
  const base = systemPrompt?.trim() ? systemPrompt : "";
  return base ? `${base}\n\n${section}` : section;
}

/** True when the agent should be offered the load_skill tool. */
export function wantsLoadSkillTool(skills: readonly PromptSkill[] | undefined, mode: SkillLoadingMode | undefined): boolean {
  return normalizeSkillLoading(mode) === "on_demand" && (skills ?? []).some((s) => s.name.trim() && fullText(s));
}

/** One-line tool description for protocol prompts. */
export const LOAD_SKILL_TOOL_LINE = `- ${LOAD_SKILL_TOOL} {"name": skill name}: the full text of one of your skills (read-only; at most ${LOAD_SKILL_MAX_CHARS.toLocaleString("en-US")} chars per call).`;

export type SkillLoadResult = { ok: boolean; text: string; name?: string; truncated?: boolean };

export interface SkillLoader {
  load(name: unknown): SkillLoadResult;
  /** Calls that returned content (counted against maxCalls). */
  readonly calls: number;
  readonly maxCalls: number;
  /** Names loaded, in order, de-duplicated. */
  readonly loaded: string[];
}

function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A per-run load_skill implementation over the agent's own skills. Names
 * match case-insensitively. A repeat load of the same skill is answered
 * without spending a call; past `maxCalls` the tool refuses.
 */
export function createSkillLoader(
  skills: readonly PromptSkill[] | undefined,
  opts: { maxCalls?: number; maxChars?: number } = {}
): SkillLoader {
  const maxCalls = opts.maxCalls ?? LOAD_SKILL_MAX_CALLS;
  const maxChars = opts.maxChars ?? LOAD_SKILL_MAX_CHARS;
  const byName = new Map<string, PromptSkill>();
  for (const skill of skills ?? []) {
    if (skill.name.trim() && fullText(skill)) byName.set(normName(skill.name), skill);
  }
  const loaded: string[] = [];
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    get maxCalls() {
      return maxCalls;
    },
    get loaded() {
      return [...loaded];
    },
    load(raw: unknown): SkillLoadResult {
      const name = typeof raw === "string" ? raw : "";
      if (!name.trim()) return { ok: false, text: `${LOAD_SKILL_TOOL} needs {"name": "<skill name>"}.` };
      const skill = byName.get(normName(name));
      if (!skill) {
        const names = [...byName.values()].map((s) => s.name).join(", ");
        return { ok: false, text: `No skill named "${name.trim()}". Your skills: ${names || "none"}.` };
      }
      if (loaded.includes(skill.name)) {
        return { ok: true, name: skill.name, text: `Skill "${skill.name}" is already loaded above; use that text.` };
      }
      if (calls >= maxCalls) {
        return {
          ok: false,
          text: `${LOAD_SKILL_TOOL} limit reached (${maxCalls} per run). Continue with the skills already loaded.`,
        };
      }
      calls += 1;
      loaded.push(skill.name);
      const body = fullText(skill);
      const header = `## Skill: ${skill.name}${skill.version ? ` (v${skill.version})` : ""}\n`;
      if (header.length + body.length <= maxChars) return { ok: true, name: skill.name, text: header + body };
      const marker = `\n… [truncated: showing ${maxChars.toLocaleString("en-US")} of ${body.length.toLocaleString("en-US")} chars]`;
      const room = Math.max(0, maxChars - header.length - marker.length);
      return { ok: true, name: skill.name, truncated: true, text: header + body.slice(0, room).trimEnd() + marker };
    },
  };
}
