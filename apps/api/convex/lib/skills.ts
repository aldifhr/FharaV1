/**
 * Library skills: pure helpers shared by the Convex chat path, the worker's
 * task runtime and the seed. No Convex functions live here.
 *
 * A skill is reusable markdown guidance attached to agents
 * (`agents.skillIds`). At run time each attached skill is appended AFTER the
 * agent's static system prompt as `## Skill: <name>\n<instructions>`, so the
 * prompt prefix stays identical across runs and prefix caching still holds.
 */

export const SKILL_NAME_MAX = 60;
export const SKILL_DESCRIPTION_MAX = 280;
export const SKILL_INSTRUCTIONS_MAX = 20_000;
export const SKILL_TAG_MAX = 32;
export const SKILL_TAGS_MAX = 12;
/** Total characters all attached skills may add to one agent prompt. */
export const SKILLS_PROMPT_BUDGET = 12_000;

/**
 * Largest body a skill may STORE (imports keep the whole SKILL.md up to
 * this; hand-written skills stay under SKILL_INSTRUCTIONS_MAX). Trimming to
 * fit the prompt happens only when a skill is injected inline.
 */
export const SKILL_STORED_MAX = 200_000;

/**
 * How an agent receives its library skills:
 *  - "inline" (default): every attached skill is appended to the system
 *    prompt, all together within SKILLS_PROMPT_BUDGET.
 *  - "on_demand": the prompt lists only each skill's name + description and
 *    the agent calls the read-only `load_skill(name)` tool for the full
 *    (untrimmed) text when it needs it.
 */
export const SKILL_LOADING_MODES = ["inline", "on_demand"] as const;
export type SkillLoadingMode = (typeof SKILL_LOADING_MODES)[number];
export const DEFAULT_SKILL_LOADING: SkillLoadingMode = "inline";

/** Name of the read-only tool that returns one skill's full text. */
export const LOAD_SKILL_TOOL = "load_skill";
/** Most characters one load_skill call returns. */
export const LOAD_SKILL_MAX_CHARS = 30_000;
/** Most load_skill calls one agent run (a subtask, or a chat reply) may make. */
export const LOAD_SKILL_MAX_CALLS = 4;
/** Characters the on-demand index (names + descriptions) may take. */
export const SKILLS_INDEX_BUDGET = 4_000;

export type PromptSkill = {
  name: string;
  /**
   * Text injected inline. For a long imported skill this is already fitted
   * under the inline cap at heading boundaries (with a trim note).
   */
  instructions: string;
  /** One-line summary, shown in the on-demand index. */
  description?: string;
  /** Untrimmed body, returned by load_skill (falls back to `instructions`). */
  fullInstructions?: string;
  /** Version this agent receives (pinned or latest). */
  version?: number;
};

/**
 * A shared-library skill as the prompt context carries it: no body. The
 * index lists it, and `load_skill` fetches the text on demand (chat:
 * internal.skillLibrary.body; worker: api.skillLibrary.bodyForWorker).
 */
export type LibrarySkillRef = {
  name: string;
  description?: string;
  /** Version this agent reads (its pin, else the latest). */
  version?: number;
};

const TRUNCATED = "\n…(truncated)";

/**
 * Render attached skills as prompt sections, in the given order, within
 * `budget` characters total. A skill that does not fit whole is cut (with a
 * marker) when there is meaningful room left; later skills are dropped.
 */
export function formatSkillsSection(
  skills: readonly PromptSkill[] | undefined,
  budget: number = SKILLS_PROMPT_BUDGET
): string {
  if (!skills?.length || budget <= 0) return "";
  const parts: string[] = [];
  let used = 0;
  for (const skill of skills) {
    const name = skill.name.trim();
    const body = skill.instructions.trim();
    if (!name || !body) continue;
    const sep = parts.length > 0 ? 2 : 0; // "\n\n" between sections
    const header = `## Skill: ${name}\n`;
    const remaining = budget - used - sep;
    const full = header + body;
    if (full.length <= remaining) {
      parts.push(full);
      used += sep + full.length;
      continue;
    }
    // Room for the header, the marker and at least a little body?
    const room = remaining - header.length - TRUNCATED.length;
    if (room >= 200) {
      parts.push(header + body.slice(0, room).trimEnd() + TRUNCATED);
    }
    break;
  }
  return parts.join("\n\n");
}

/** Static system prompt first, then the skills section (prefix-cache friendly). */
export function appendSkillsToPrompt(
  systemPrompt: string | undefined,
  skills: readonly PromptSkill[] | undefined,
  budget: number = SKILLS_PROMPT_BUDGET
): string | undefined {
  const section = formatSkillsSection(skills, budget);
  const base = systemPrompt?.trim() ? systemPrompt : "";
  if (!section) return systemPrompt;
  return base ? `${base}\n\n${section}` : section;
}

/** Normalize + validate user input for create/update. Throws on bad input. */
export function validateSkillInput(
  input: {
    name?: string;
    description?: string;
    instructions?: string;
    tags?: string[];
  },
  opts: { instructionsMax?: number } = {}
): { name?: string; description?: string; instructions?: string; tags?: string[] } {
  const instructionsMax = opts.instructionsMax ?? SKILL_INSTRUCTIONS_MAX;
  const out: { name?: string; description?: string; instructions?: string; tags?: string[] } = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("Skill name is required");
    if (name.length > SKILL_NAME_MAX) throw new Error(`Skill name must be ${SKILL_NAME_MAX} characters or fewer`);
    out.name = name;
  }
  if (input.description !== undefined) {
    const description = input.description.trim();
    if (description.length > SKILL_DESCRIPTION_MAX) {
      throw new Error(`Description must be ${SKILL_DESCRIPTION_MAX} characters or fewer`);
    }
    out.description = description;
  }
  if (input.instructions !== undefined) {
    const instructions = input.instructions.trim();
    if (!instructions) throw new Error("Skill instructions are required");
    if (instructions.length > instructionsMax) {
      throw new Error(`Instructions must be ${instructionsMax} characters or fewer`);
    }
    out.instructions = instructions;
  }
  if (input.tags !== undefined) {
    const tags = Array.from(
      new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))
    );
    if (tags.length > SKILL_TAGS_MAX) throw new Error(`At most ${SKILL_TAGS_MAX} tags`);
    if (tags.some((t) => t.length > SKILL_TAG_MAX)) {
      throw new Error(`Tags must be ${SKILL_TAG_MAX} characters or fewer`);
    }
    out.tags = tags;
  }
  return out;
}

/** Starter skills offered on an empty library (skills:seedDefaults). */
export const DEFAULT_SKILLS: Array<{ name: string; description: string; tags: string[]; instructions: string }> = [
  {
    name: "Conventional commits",
    description: "Write commit messages and PR titles in the Conventional Commits format.",
    tags: ["git", "workflow"],
    instructions: [
      "When you write a commit message, branch summary or PR title, use Conventional Commits:",
      "",
      "- Format: `<type>(<scope>): <summary>` — e.g. `fix(api): reject empty skill names`.",
      "- Types: feat, fix, refactor, perf, test, docs, style, build, ci, chore.",
      "- Summary: imperative mood, lower case, no trailing period, 72 characters max.",
      "- Scope: the package or area touched (web, api, worker, …); omit when it spans everything.",
      "- Body (optional): explain *why*, wrap at 72 columns, separate from the summary with a blank line.",
      "- Breaking changes: add `!` after the type/scope and a `BREAKING CHANGE:` footer.",
      "- One logical change per commit; never mix a refactor with a behaviour change.",
    ].join("\n"),
  },
  {
    name: "Accessible UI checklist",
    description: "Check every UI change against a short accessibility list before calling it done.",
    tags: ["frontend", "a11y"],
    instructions: [
      "Before you finish any UI change, check it against this list and fix what fails:",
      "",
      "- Use semantic elements first: `button` for actions, `a` for navigation, real `label`s for inputs.",
      "- Every interactive element is reachable and usable with the keyboard, in a logical tab order.",
      "- Focus is always visible (do not remove outlines without a replacement ring).",
      "- Icon-only buttons have an `aria-label`; decorative icons get `aria-hidden`.",
      "- Images have meaningful `alt` text, or `alt=\"\"` when purely decorative.",
      "- Text contrast is at least 4.5:1 (3:1 for large text and UI borders).",
      "- Dialogs trap focus, close on Escape, and return focus to the trigger.",
      "- Errors are announced (`role=\"alert\"`) and say how to fix the problem.",
      "- Do not rely on colour alone to convey state.",
    ].join("\n"),
  },
  {
    name: "Write tests first",
    description: "Start behaviour changes with a failing test, then make it pass.",
    tags: ["testing", "workflow"],
    instructions: [
      "For any bug fix or behaviour change, work test-first:",
      "",
      "1. Find the existing test file for the module (match its framework and style; do not add a new framework).",
      "2. Write the smallest test that reproduces the bug or describes the new behaviour. It must fail for the right reason.",
      "3. Make the minimal change that makes it pass.",
      "4. Refactor only with the tests green.",
      "5. Cover the edge cases you touched: empty input, limits, error paths.",
      "",
      "Keep tests deterministic: no real network, clock or randomness without a seam. Mention in your summary which tests you added and that they pass.",
    ].join("\n"),
  },
];
