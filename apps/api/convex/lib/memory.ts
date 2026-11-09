/**
 * Memory: pure helpers shared by the Convex functions (memories.ts), the
 * chat path (chatContext.ts), the worker's task runtime (runner/setup.ts)
 * and the web /memory page. No Convex functions live here.
 *
 * Three scopes: "shared" (every agent, every project), "project" (every
 * agent working in that project) and "agent" (one agent, every project).
 * Only PINNED memories reach a prompt. They are appended after the static
 * system prompt and the skills section as one "## Memory" section, so the
 * prompt prefix stays identical across runs and prefix caching holds.
 * Unpinned memories are reference-only for now.
 */

export const MEMORY_TITLE_MAX = 120;
export const MEMORY_CONTENT_MAX = 4000;
export const MEMORY_TAG_MAX = 32;
export const MEMORY_TAGS_MAX = 12;
/** Total characters the "## Memory" section may add to one prompt. */
export const MEMORY_PROMPT_BUDGET = 6000;

export const MEMORY_SCOPES = ["shared", "project", "agent"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export type PromptMemory = { title: string; content: string };

/** The fields injection needs from a memory row. */
export type MemoryLike = {
  scope: MemoryScope;
  projectId?: string;
  agentId?: string;
  title: string;
  content: string;
  pinned: boolean;
  createdAt: number;
};

const TRUNCATED = "\n…(truncated)";
const HEADER = "## Memory\nStanding notes from the team's memory. Treat them as context, not as a task.";

/**
 * Memories that reach a prompt, in injection order: pinned shared, then
 * pinned project memories for `projectId`, then the agent's own pinned
 * memories. Oldest first inside each group, so adding a memory appends to
 * the section instead of reshuffling it.
 */
export function selectPromptMemories(
  rows: readonly MemoryLike[],
  target: { projectId?: string; agentId?: string }
): PromptMemory[] {
  const byAge = (a: MemoryLike, b: MemoryLike) => a.createdAt - b.createdAt;
  const pinned = rows.filter((row) => row.pinned);
  const shared = pinned.filter((row) => row.scope === "shared").sort(byAge);
  const project = target.projectId
    ? pinned.filter((row) => row.scope === "project" && row.projectId === target.projectId).sort(byAge)
    : [];
  const agent = target.agentId
    ? pinned.filter((row) => row.scope === "agent" && row.agentId === target.agentId).sort(byAge)
    : [];
  return [...shared, ...project, ...agent].map(({ title, content }) => ({ title, content }));
}

/**
 * Render memories as one "## Memory" section within `budget` characters,
 * header included. A memory that does not fit whole is cut (with a marker)
 * when there is meaningful room left; later ones are dropped.
 */
export function formatMemorySection(
  memories: readonly PromptMemory[] | undefined,
  budget: number = MEMORY_PROMPT_BUDGET
): string {
  if (!memories?.length || budget <= HEADER.length) return "";
  const parts: string[] = [];
  let used = HEADER.length;
  for (const memory of memories) {
    const title = memory.title.trim();
    const body = memory.content.trim();
    if (!title && !body) continue;
    const head = `### ${title || "Note"}\n`;
    const remaining = budget - used - 2; // "\n\n" before each entry
    const full = head + body;
    if (full.length <= remaining) {
      parts.push(full);
      used += 2 + full.length;
      continue;
    }
    const room = remaining - head.length - TRUNCATED.length;
    if (room >= 200) parts.push(head + body.slice(0, room).trimEnd() + TRUNCATED);
    break;
  }
  if (!parts.length) return "";
  return [HEADER, ...parts].join("\n\n");
}

/** Prompt (static prompt + skills) first, then the memory section. */
export function appendMemoryToPrompt(
  systemPrompt: string | undefined,
  memorySection: string | undefined
): string | undefined {
  if (!memorySection?.trim()) return systemPrompt;
  return systemPrompt?.trim() ? `${systemPrompt}\n\n${memorySection}` : memorySection;
}

export type MemoryInput = { title?: string; content?: string; tags?: string[] };

/** Normalize + validate user input for create/update. Throws on bad input. */
export function validateMemoryInput(input: MemoryInput): MemoryInput {
  const out: MemoryInput = {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new Error("Memory title is required");
    if (title.length > MEMORY_TITLE_MAX) throw new Error(`Title must be ${MEMORY_TITLE_MAX} characters or fewer`);
    out.title = title;
  }
  if (input.content !== undefined) {
    const content = input.content.trim();
    if (!content) throw new Error("Memory content is required");
    if (content.length > MEMORY_CONTENT_MAX) throw new Error(`Content must be ${MEMORY_CONTENT_MAX} characters or fewer`);
    out.content = content;
  }
  if (input.tags !== undefined) {
    const tags = Array.from(new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean)));
    if (tags.length > MEMORY_TAGS_MAX) throw new Error(`At most ${MEMORY_TAGS_MAX} tags`);
    if (tags.some((t) => t.length > MEMORY_TAG_MAX)) throw new Error(`Tags must be ${MEMORY_TAG_MAX} characters or fewer`);
    out.tags = tags;
  }
  return out;
}

/** Title + content for "Remember" on a chat message. */
export function memoryFromMessage(content: string): { title: string; content: string } {
  const clean = content.replace(/\r\n/g, "\n").trim();
  const firstLine = (clean.split("\n").find((line) => line.trim()) ?? "Note")
    .replace(/^[#>*\-\s]+/, "")
    .trim();
  const title = firstLine.length > 80 ? `${firstLine.slice(0, 79).trimEnd()}…` : firstLine || "Note";
  const body = clean.length > MEMORY_CONTENT_MAX ? `${clean.slice(0, MEMORY_CONTENT_MAX - 1).trimEnd()}…` : clean;
  return { title, content: body };
}
