/**
 * Routing hint (P1a): what chat already decided about a request (who owns
 * it, its domain and code topic, the intent kind, the plan line, the files
 * it names), carried from the chat offer onto the task so the worker planner
 * starts from it instead of re-deriving everything from the command text.
 *
 * A hint is a PRIOR, not a mandate: the planner may override it (it logs
 * plan.hint_overridden). Only an explicit user @mention is binding
 * (`hard: true`), which keeps the pool constraint it always had.
 *
 * Pure apart from the Convex validators: no Node or database APIs.
 */
import { v, type Infer } from "convex/values";
import { isRoleKey, normalizeRoleKey, type RoleKey } from "./roles";

export const routingHintValidator = v.object({
  source: v.union(v.literal("route"), v.literal("offer"), v.literal("mention"), v.literal("command")),
  role: v.optional(v.string()),
  domain: v.optional(v.string()),
  topic: v.optional(v.string()),
  kind: v.optional(v.string()),
  brief: v.optional(v.string()),
  files: v.optional(v.array(v.string())),
  hard: v.optional(v.boolean()),
});

export type RoutingHint = Infer<typeof routingHintValidator>;

/**
 * The Create task offer stored on a chat reply (messages.taskOffer). `kind`
 * is the intent subtype ("testing", "implementation", …), `commands` the
 * allowlisted lines a run request asked for, `assigneeAgentId` who the task
 * goes to, `brief` the prefilled task text, `hint` the routing hint the
 * task inherits. `usedTaskId`/`usedAt` are set once a task was created.
 */
export const taskOfferValidator = v.object({
  kind: v.string(),
  commands: v.optional(v.array(v.string())),
  assigneeAgentId: v.optional(v.string()),
  brief: v.optional(v.string()),
  hint: v.optional(routingHintValidator),
  usedTaskId: v.optional(v.id("tasks")),
  usedAt: v.optional(v.number()),
});

/** At most this many file names ride on a hint. */
export const MAX_HINT_FILES = 8;
const MAX_BRIEF = 300;
const MAX_TOPIC = 120;

// A path ("src/lib/a.ts", "apps/web/") or a bare file name with an extension.
const FILE_TOKEN = /(?:^|[\s`'"(])((?:\.?\/)?(?:[\w.@-]+\/)+[\w.@-]*|[\w@-]+(?:\.[\w-]+)*\.(?:tsx?|jsx?|mjs|cjs|html?|css|scss|sass|less|vue|svelte|py|go|rs|java|rb|php|json|md|ya?ml|toml|sql|prisma|sh))(?=$|[\s`'"),:;!?]|\.(?:\s|$))/g;

/** Path-like tokens a request names, de-duplicated, in order, at most MAX_HINT_FILES. */
export function hintFiles(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(FILE_TOKEN)) {
    const file = match[1].replace(/^\.\//, "").replace(/[.]+$/, "");
    // URLs are not files ("https://x.y/z").
    if (!file || /^(?:https?:|www\.)/i.test(file) || /:\/\//.test(match[0])) continue;
    if (!out.includes(file)) out.push(file);
    if (out.length >= MAX_HINT_FILES) break;
  }
  return out;
}

/** A role string as one of the 9 fixed role keys, or undefined. */
export function hintRole(role: string | undefined | null): RoleKey | undefined {
  const key = normalizeRoleKey(role ?? "");
  return isRoleKey(key) ? key : undefined;
}

/**
 * Builds a hint from what chat knows; empty fields are left out. `text` is
 * the user's request (files are read from it); `brief` is the plan line,
 * never a copy of the request.
 */
export function buildRoutingHint(input: {
  source: RoutingHint["source"];
  role?: string | null;
  domain?: string | null;
  topic?: string | null;
  kind?: string | null;
  brief?: string | null;
  text?: string;
  hard?: boolean;
}): RoutingHint {
  // The CTO plans and approves architecture; it never owns the work, so it is never a hint's role.
  const role = hintRole(input.role) === "cto" ? undefined : hintRole(input.role);
  const files = input.text ? hintFiles(input.text) : [];
  const brief = input.brief?.trim().slice(0, MAX_BRIEF);
  const topic = input.topic?.trim().slice(0, MAX_TOPIC);
  return {
    source: input.source,
    ...(role ? { role } : {}),
    ...(input.domain ? { domain: input.domain } : {}),
    ...(topic ? { topic } : {}),
    ...(input.kind && input.kind !== "other" ? { kind: input.kind } : {}),
    ...(brief ? { brief } : {}),
    ...(files.length ? { files } : {}),
    ...(input.hard ? { hard: true } : {}),
  };
}

/** A stored value read back as a hint (tolerates legacy / partial rows). */
export function readRoutingHint(value: unknown): RoutingHint | null {
  if (!value || typeof value !== "object") return null;
  const hint = value as Partial<RoutingHint>;
  if (!["route", "offer", "mention", "command"].includes(String(hint.source))) return null;
  return hint as RoutingHint;
}
