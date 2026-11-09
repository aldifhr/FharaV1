/**
 * Skill v2 — on-demand skills in task runs.
 *
 * An agent with `skillLoading: "on_demand"` carries only a skills index in
 * its system prompt (setup.toAgentDefinition). Before a subtask runs, this
 * step gives the agent the read-only `load_skill` tool in a short bounded
 * loop: the model asks for the skills that bear on the subtask (one JSON
 * call per reply), each answer comes from the agent's own attached skills
 * (createSkillLoader: full untrimmed text, LOAD_SKILL_MAX_CHARS per call,
 * LOAD_SKILL_MAX_CALLS per run), and the loaded text is appended to the
 * system prompt that every executor path (API, OpenCode, review, QA)
 * then reads.
 *
 * Read-only by construction: it only returns text the agent was given, and
 * it never touches `supportedTools` or any permission — a skill that
 * declares `run_command` does not get the agent run_command.
 */
import { extractToolCalls } from "@/api/convex/lib/chat/toolCallText";
import { createSkillLoader, LOAD_SKILL_TOOL_LINE, wantsLoadSkillTool } from "@/api/convex/lib/skillRuntime";
import { LOAD_SKILL_MAX_CALLS, LOAD_SKILL_MAX_CHARS, LOAD_SKILL_TOOL, type PromptSkill } from "@/api/convex/lib/skills";

export type SkillPreloadMessage = { role: "system" | "user" | "assistant"; content: string };

export interface SkillPreloadParams {
  systemPrompt: string | undefined;
  skills: readonly PromptSkill[] | undefined;
  /** What the agent is about to do (subtask title + description + task command). */
  assignment: string;
  /** One LLM call; returns the reply text. */
  call: (messages: SkillPreloadMessage[]) => Promise<string>;
  maxCalls?: number;
  maxChars?: number;
}

export interface SkillPreloadResult {
  systemPrompt: string | undefined;
  loaded: string[];
  /** load_skill calls that returned content. */
  loads: number;
  /** LLM calls made by the loop. */
  llmCalls: number;
  failed: Array<{ name: string; reason: string }>;
}

export const SKILL_PRELOAD_DONE = "DONE";

export function skillPreloadInstruction(assignment: string, maxCalls: number): string {
  return [
    "Before you start this work, read the skills from your list that bear on it.",
    `Tool: ${LOAD_SKILL_TOOL_LINE.replace(/^- /, "")}`,
    `To load one, reply with ONLY {"tool":"${LOAD_SKILL_TOOL}","arguments":{"name":"<skill name>"}} — one call per reply. At most ${maxCalls} skills.`,
    `When you have what you need (or no skill applies), reply with just ${SKILL_PRELOAD_DONE}. Do not start the work yet.`,
    "",
    "Work:",
    assignment.trim(),
  ].join("\n");
}

/** Run the bounded load_skill loop; returns the system prompt with the loaded skills appended. */
export async function preloadOnDemandSkills(params: SkillPreloadParams): Promise<SkillPreloadResult> {
  const maxCalls = params.maxCalls ?? LOAD_SKILL_MAX_CALLS;
  const result: SkillPreloadResult = {
    systemPrompt: params.systemPrompt,
    loaded: [],
    loads: 0,
    llmCalls: 0,
    failed: [],
  };
  if (!wantsLoadSkillTool(params.skills, "on_demand")) return result;
  const loader = createSkillLoader(params.skills, { maxCalls, maxChars: params.maxChars ?? LOAD_SKILL_MAX_CHARS });
  const messages: SkillPreloadMessage[] = [
    ...(params.systemPrompt ? [{ role: "system" as const, content: params.systemPrompt }] : []),
    { role: "user", content: skillPreloadInstruction(params.assignment, maxCalls) },
  ];
  const texts: string[] = [];
  // One reply per load plus the closing reply; failed calls also spend a step.
  for (let step = 0; step <= maxCalls + 1; step += 1) {
    const reply = await params.call(messages);
    result.llmCalls += 1;
    const found = extractToolCalls(reply);
    const call = found.calls.find((c) => c.tool === LOAD_SKILL_TOOL);
    if (!call) break;
    const name = call.args?.name ?? call.args?.skill;
    const loaded = loader.load(name);
    if (loaded.ok && loaded.name && !result.loaded.includes(loaded.name)) {
      result.loaded.push(loaded.name);
      texts.push(loaded.text);
    } else if (!loaded.ok) {
      result.failed.push({ name: typeof name === "string" ? name : "", reason: loaded.text });
    }
    if (loader.calls >= maxCalls) break;
    messages.push({ role: "assistant", content: JSON.stringify({ tool: LOAD_SKILL_TOOL, arguments: { name } }) });
    messages.push({
      role: "user",
      content: `[tool result: ${LOAD_SKILL_TOOL}${loaded.ok ? "" : " — failed"}]\n${loaded.text}\n\nLoad another skill, or reply ${SKILL_PRELOAD_DONE}.`,
    });
  }
  result.loads = loader.calls;
  if (texts.length) {
    const section = ["## Loaded skills", "Full text of the skills you loaded for this work:", ...texts].join("\n\n");
    result.systemPrompt = params.systemPrompt?.trim() ? `${params.systemPrompt}\n\n${section}` : section;
  }
  return result;
}
