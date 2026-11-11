/**
 * "Decision needed" tray (chat UX, Feature 2): turns the project's
 * pending approvals, open task questions and the CTO's latest unanswered
 * option prompt into one ordered list the composer dock pages through.
 *
 * Pure (no React, no Convex) so the aggregation is unit-tested in the
 * backend suite; the web app imports it from `@/api/convex/lib/decisionTray`.
 *
 * Order: a command the agent is blocked on right now first (it holds a
 * live worker lease), then other approvals oldest first, then questions /
 * escalations, then the option prompt. Push-like commands never get
 * "Always allow"; the server enforces that too (commandApprovals.respond).
 */

export type TrayItemKind = "command" | "approval" | "plan" | "question" | "options";

export type TrayActionId = "allow" | "always" | "always_exact" | "deny" | "approve" | "reject" | "open" | `answer:${number}` | `pick:${string}`;

export interface TrayAction {
  id: TrayActionId;
  label: string;
  primary?: boolean;
  /** Destructive: the UI confirms with ConfirmDialog before running it. */
  confirm?: boolean;
}

/** What text typed in the composer does while this item is current. */
export type TrayComposerMode = "deny_with_note" | "answer" | "chat";

export interface TrayItem {
  key: string;
  kind: TrayItemKind;
  title: string;
  /** Mono code block (commands). */
  code?: string;
  /** Quiet context line: who asks and for which task. */
  meta?: string;
  /** Why this one always asks (dangerous / push-like commands). */
  warning?: string;
  actions: TrayAction[];
  composerMode: TrayComposerMode;
  approvalId?: string;
  taskId?: string;
  messageId?: string;
  options?: string[];
  at: number;
}

export interface TrayApprovalInput {
  _id: string;
  _creationTime: number;
  kind: string;
  summary: string;
  taskId: string;
  payload?: any;
  offerAlways?: boolean;
  agentRole?: string | null;
  taskTitle?: string | null;
  conversationId?: string | null;
}

export interface TrayQuestionInput {
  taskId: string;
  title: string;
  question: string | null;
  options?: string[];
  agentRole?: string | null;
  conversationId?: string | null;
  at: number;
}

export interface TrayOptionPromptInput {
  messageId: string;
  agentRole?: string | null;
  question?: string;
  options: Array<{ id: string; title: string }>;
  at: number;
}

const KIND_TITLE: Record<string, string> = {
  apply_changes: "Apply changes",
  git_push: "Push to remote",
  merge_pr: "Merge pull request",
  run_command: "Run command",
};

const roleName = (role?: string | null) => {
  const r = (role ?? "").trim();
  if (!r) return "";
  return /^(cto|qa|ui|ux|api)$/i.test(r) ? r.toUpperCase() : r.charAt(0).toUpperCase() + r.slice(1);
};

function meta(role?: string | null, taskTitle?: string | null): string | undefined {
  const parts = [roleName(role), taskTitle ?? ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/** In this chat: tasks dispatched from it, or with no conversation at all. */
function inScope(conversationId: string | null | undefined, current: string | null | undefined): boolean {
  return !conversationId || !current || conversationId === current;
}

export function approvalTrayItem(a: TrayApprovalInput): TrayItem {
  const base = { approvalId: a._id, taskId: a.taskId, at: a._creationTime, meta: meta(a.agentRole, a.taskTitle) };
  if (a.kind === "run_command") {
    const command = String(a.payload?.command ?? a.summary.replace(/^Run\s+/, ""));
    const danger = typeof a.payload?.danger === "string" ? a.payload.danger : undefined;
    const actions: TrayAction[] = [{ id: "allow", label: "Allow", primary: true }];
    if (a.offerAlways === true && !danger) {
      const head = typeof a.payload?.head === "string" && a.payload.head ? a.payload.head : null;
      actions.push({ id: "always", label: head ? `Always allow ${head}` : "Always allow" });
      // Plan 041: narrower than the head rule — only this literal argv.
      actions.push({ id: "always_exact", label: "Always allow this exact command" });
    }
    actions.push({ id: "deny", label: "Deny" });
    return {
      ...base,
      key: `approval:${a._id}`,
      kind: "command",
      title: "An agent wants to run a command",
      code: command,
      ...(danger ? { warning: danger } : {}),
      actions,
      composerMode: "deny_with_note",
    };
  }
  if (a.kind === "plan") {
    return {
      ...base,
      key: `approval:${a._id}`,
      kind: "plan",
      title: a.summary || "Review the plan",
      actions: [
        { id: "approve", label: "Approve plan", primary: true },
        { id: "open", label: "Open plan" },
        { id: "reject", label: "Deny", confirm: true },
      ],
      composerMode: "chat",
    };
  }
  const push = a.kind === "git_push" || a.kind === "merge_pr";
  return {
    ...base,
    key: `approval:${a._id}`,
    kind: "approval",
    title: a.summary || KIND_TITLE[a.kind] || a.kind,
    meta: [KIND_TITLE[a.kind], base.meta].filter(Boolean).join(" · ") || undefined,
    actions: [
      { id: "approve", label: push ? "Approve push" : "Approve", primary: true },
      { id: "open", label: a.kind === "apply_changes" ? "View diff" : "Open task" },
      { id: "reject", label: "Deny", confirm: true },
    ],
    composerMode: "chat",
  };
}

export function questionTrayItem(q: TrayQuestionInput): TrayItem {
  const options = (q.options ?? []).map((o) => o.trim()).filter(Boolean).slice(0, 6);
  return {
    key: `question:${q.taskId}`,
    kind: "question",
    title: q.question || `Answer: ${q.title}`,
    meta: meta(q.agentRole, q.title),
    actions: [
      ...options.map((label, i) => ({ id: `answer:${i}` as const, label, ...(i === 0 ? { primary: true } : {}) })),
      { id: "open" as const, label: "Open task" },
    ],
    composerMode: "answer",
    taskId: q.taskId,
    options,
    at: q.at,
  };
}

export function optionsTrayItem(p: TrayOptionPromptInput): TrayItem {
  return {
    key: `options:${p.messageId}`,
    kind: "options",
    title: p.question?.trim() || "Pick one option",
    meta: roleName(p.agentRole) || undefined,
    actions: p.options.slice(0, 6).map((o) => ({ id: `pick:${o.id}` as const, label: `${o.id}. ${o.title}` })),
    composerMode: "chat",
    messageId: p.messageId,
    at: p.at,
  };
}

/** The ordered tray for one chat. */
export function buildDecisionTray(input: {
  approvals?: TrayApprovalInput[];
  questions?: TrayQuestionInput[];
  optionPrompt?: TrayOptionPromptInput | null;
  conversationId?: string | null;
}): TrayItem[] {
  const approvals = (input.approvals ?? []).filter((a) => inScope(a.conversationId, input.conversationId));
  const commands = approvals.filter((a) => a.kind === "run_command").map(approvalTrayItem);
  const others = approvals.filter((a) => a.kind !== "run_command").map(approvalTrayItem);
  const byTime = (a: TrayItem, b: TrayItem) => a.at - b.at;
  const questions = (input.questions ?? [])
    .filter((q) => inScope(q.conversationId, input.conversationId))
    .map(questionTrayItem)
    .sort(byTime);
  const options = input.optionPrompt && input.optionPrompt.options.length > 1 ? [optionsTrayItem(input.optionPrompt)] : [];
  return [...commands.sort(byTime), ...others.sort(byTime), ...questions, ...options];
}

/** Keep the pager on the same item when the list changes (by key), else clamp. */
export function nextTrayIndex(prev: TrayItem[], next: TrayItem[], index: number): number {
  if (next.length === 0) return 0;
  const key = prev[index]?.key;
  const kept = key ? next.findIndex((item) => item.key === key) : -1;
  if (kept >= 0) return kept;
  return Math.min(Math.max(0, index), next.length - 1);
}

/** The latest agent option prompt with no user message after it, or null. */
export function latestOpenOptionPrompt<M extends { _id: string; _creationTime: number; authorType: string; agentId?: string; content?: string }>(
  timeline: M[],
  parse: (content: string) => { text: string; options: Array<{ id: string; title: string }> },
  roleOf: (agentId?: string) => string | null | undefined
): TrayOptionPromptInput | null {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const m = timeline[i];
    if (m.authorType === "user") return null;
    if (m.authorType !== "agent" || !m.content) continue;
    const { text, options } = parse(m.content);
    if (options.length < 2) continue;
    const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const question = [...lines].reverse().find((l) => /\?\s*$/.test(l));
    return { messageId: String(m._id), agentRole: roleOf(m.agentId), question, options, at: m._creationTime };
  }
  return null;
}
