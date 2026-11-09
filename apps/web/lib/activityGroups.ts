/**
 * Compact activity log (inspired by goat-si/goat, MIT): consecutive
 * tool / progress / file-change / check items from the same agent collapse
 * into one summary row such as "Frontend · Edited 2 files, ran
 * typecheck/lint/build (failed lint)". Pure: no React, unit tested.
 *
 * Rules
 * - An activity item is a message carrying a `changes`, `verification` or
 *   `qa` card, a delegation / handoff line, or a plain "Read …" progress
 *   line. Assignment and push cards (they ask for a decision) and normal
 *   replies are never grouped.
 * - Consecutive items from the same agent in the same block form a group;
 *   a group needs at least `minSize` (default 2) items, a lone card stays
 *   as it is.
 * - Summary priority: file changes, checks, delegations, reads. At most two
 *   categories are named; the rest becomes "+N more" (N = their items).
 * - A failed check is listed as failed and never counted as a success; a
 *   group with any failed item is `failed` (red dot), and the latest failing
 *   group starts expanded.
 */

export type ActivityCategory = "edit" | "check" | "delegate" | "read";

export const CATEGORY_ORDER: ActivityCategory[] = ["edit", "check", "delegate", "read"];

export interface ActivityMessageLike {
  _id: string;
  authorType?: string;
  agentId?: string;
  taskId?: string;
  content?: string;
  card?: { kind?: string; data?: any } | null;
}

export interface ActivityCheck {
  name: string;
  status: "passed" | "failed" | "running";
}

export interface ActivityItem {
  category: ActivityCategory;
  /** Files edited / read, or 1 per delegation. */
  count: number;
  /** Checks that ran (category "check"); not-run steps are left out. */
  checks?: ActivityCheck[];
  /** Delegation target (category "delegate"). */
  target?: string;
  failed: boolean;
}

export interface ActivityGroup {
  /** Id of the group's first message (stable while the group grows). */
  id: string;
  /** Inclusive indices into the input list. */
  start: number;
  end: number;
  messageIds: string[];
  agentId?: string;
  summary: string;
  failed: boolean;
  expandedByDefault: boolean;
}

const DELEGATION = /^Delegation:\s*(.+?)\s*→\s*(.+?)\s*\(/s;
const HANDOFF = /^@([\w-]+)\s/;
const READ = /^(?:Read|Reading)\s+(\d+)?\s*files?\b/i;

function checkStatus(status: unknown): ActivityCheck["status"] | null {
  if (status === "passed" || status === "clean") return "passed";
  if (status === "failed" || status === "blocked") return "failed";
  if (status === "running" || status === "pending") return "running";
  return null; // not_run and unknown: did not run, not reported
}

/** The activity item a message represents, or null for a normal message. */
export function activityItemOf(message: ActivityMessageLike): ActivityItem | null {
  if (message.authorType !== "agent") return null;
  const card = message.card;
  if (card && card.data) {
    const data = card.data;
    switch (card.kind) {
      case "changes": {
        const files = Array.isArray(data.files) ? data.files.length : 0;
        return { category: "edit", count: Math.max(files, 1), failed: false };
      }
      case "verification": {
        const raw: any[] = Array.isArray(data.checks) ? data.checks : [];
        const checks: ActivityCheck[] = [];
        for (const check of raw) {
          const status = checkStatus(check?.status);
          if (status && typeof check?.name === "string") checks.push({ name: check.name, status });
        }
        if (checks.length === 0) {
          const status = data.outcome === "passed" ? "passed" : data.outcome === "failed" ? "failed" : null;
          if (status) checks.push({ name: "verification", status });
        }
        return {
          category: "check",
          count: checks.length,
          checks,
          failed: data.outcome === "failed" || checks.some((check) => check.status === "failed"),
        };
      }
      case "qa": {
        const status: ActivityCheck["status"] =
          data.outcome === "passed" ? "passed" : data.outcome === "running" ? "running" : "failed";
        return { category: "check", count: 1, checks: [{ name: "QA", status }], failed: status === "failed" };
      }
      default:
        return null;
    }
  }
  if (card) return null;
  const content = (message.content ?? "").trim();
  const delegation = DELEGATION.exec(content);
  if (delegation) return { category: "delegate", count: 1, target: delegation[2], failed: false };
  const handoff = HANDOFF.exec(content);
  if (handoff) return { category: "delegate", count: 1, target: handoff[1], failed: false };
  const read = READ.exec(content);
  if (read && content.length <= 200) {
    return { category: "read", count: read[1] ? Number(read[1]) : 1, failed: false };
  }
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function describeChecks(items: ActivityItem[]): string {
  const ran: string[] = [];
  const failed: string[] = [];
  let total = 0;
  let running = false;
  for (const item of items) {
    for (const check of item.checks ?? []) {
      if (check.status === "running") {
        running = true;
        continue;
      }
      total += 1;
      if (!ran.includes(check.name)) ran.push(check.name);
      if (check.status === "failed" && !failed.includes(check.name)) failed.push(check.name);
    }
  }
  if (total === 0) return running ? "running checks" : "ran no checks";
  const named = ran.length <= 4 && total === ran.length;
  let text = named ? `ran ${ran.join("/")}` : `ran ${plural(total, "check")}`;
  if (failed.length > 0) {
    text += named || failed.length <= 2 ? ` (failed ${failed.join("/")})` : ` (${failed.length} failed)`;
  }
  if (running) text += ", more running";
  return text;
}

function describeCategory(category: ActivityCategory, items: ActivityItem[]): string {
  switch (category) {
    case "edit":
      return `edited ${plural(items.reduce((sum, item) => sum + item.count, 0), "file")}`;
    case "check":
      return describeChecks(items);
    case "delegate": {
      const targets = Array.from(new Set(items.map((item) => item.target ?? "?")));
      if (items.length === 1) return `handed off to ${targets[0]}`;
      if (targets.length === 1) return `sent ${items.length} handoffs to ${targets[0]}`;
      return `sent ${plural(items.length, "handoff")} to ${targets.length} agents`;
    }
    case "read":
      return `read ${plural(items.reduce((sum, item) => sum + item.count, 0), "file")}`;
  }
}

/** "Edited 2 files, ran typecheck/lint (failed lint) +1 more". */
export function summarizeActivity(items: ActivityItem[], label?: string): string {
  const byCategory = new Map<ActivityCategory, ActivityItem[]>();
  for (const item of items) {
    byCategory.set(item.category, [...(byCategory.get(item.category) ?? []), item]);
  }
  const present = CATEGORY_ORDER.filter((category) => byCategory.has(category));
  const shown = present.slice(0, 2);
  const rest = present.slice(2).reduce((sum, category) => sum + (byCategory.get(category)?.length ?? 0), 0);
  let text = shown.map((category) => describeCategory(category, byCategory.get(category) ?? [])).join(", ");
  if (rest > 0) text += ` +${rest} more`;
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return label ? `${label} · ${text}` : text;
}

export interface GroupOptions {
  /** Whether two neighbouring messages belong to the same block (default: same taskId). */
  sameBlock?: (a: ActivityMessageLike, b: ActivityMessageLike) => boolean;
  /** Display label of an agent, e.g. its role ("Frontend"). */
  agentLabel?: (agentId: string | undefined) => string | undefined;
  /** Smallest run that collapses (default 2). */
  minSize?: number;
}

/** Runs of consecutive activity items from one agent, summarized. */
export function groupActivity(messages: ActivityMessageLike[], options: GroupOptions = {}): ActivityGroup[] {
  const sameBlock = options.sameBlock ?? ((a, b) => (a.taskId ?? null) === (b.taskId ?? null));
  const minSize = Math.max(2, options.minSize ?? 2);
  const items = messages.map(activityItemOf);
  const groups: ActivityGroup[] = [];
  let index = 0;
  while (index < messages.length) {
    if (!items[index]) {
      index += 1;
      continue;
    }
    let end = index;
    while (
      end + 1 < messages.length &&
      items[end + 1] &&
      messages[end + 1].agentId === messages[index].agentId &&
      sameBlock(messages[end], messages[end + 1])
    ) {
      end += 1;
    }
    if (end - index + 1 >= minSize) {
      const run = items.slice(index, end + 1) as ActivityItem[];
      groups.push({
        id: String(messages[index]._id),
        start: index,
        end,
        messageIds: messages.slice(index, end + 1).map((message) => String(message._id)),
        agentId: messages[index].agentId,
        summary: summarizeActivity(run, options.agentLabel?.(messages[index].agentId)),
        failed: run.some((item) => item.failed),
        expandedByDefault: false,
      });
    }
    index = end + 1;
  }
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    if (groups[i].failed) {
      groups[i].expandedByDefault = true;
      break;
    }
  }
  return groups;
}

/** Index → group, for list renderers that walk messages one by one. */
export function groupByIndex(groups: ActivityGroup[]): Map<number, ActivityGroup> {
  const map = new Map<number, ActivityGroup>();
  for (const group of groups) {
    for (let i = group.start; i <= group.end; i += 1) map.set(i, group);
  }
  return map;
}
