/**
 * Run export: turns the `api.runs.get` payload into a compact Markdown
 * report (for pasting into an AI assistant) or a JSON dump.
 *
 * Pure: no DOM, no Convex, no clock. `exportedAt` comes in through the
 * options so the output is deterministic and testable. Times are rendered
 * in the runtime's local zone, and the report states that zone.
 */
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/api/convex/_generated/api";
import { formatCost, formatDuration, formatTokens, isErrorStatus } from "./runFormat";

export type RunExportData = NonNullable<FunctionReturnType<typeof api.runs.get>>;
type Step = RunExportData["steps"][number];
type RunEvent = RunExportData["events"][number];

export type RunExportOptions = {
  /** Epoch ms of the export. */
  exportedAt: number;
  appVersion?: string | null;
  /** Soft cap on the whole Markdown document. */
  maxChars?: number;
};

const EXPORT_LIMITS = {
  maxChars: 60_000,
  errorBlock: 4_000,
  ioBlock: 2_000,
  checkDetails: 1_500,
  eventPayload: 300,
  events: 150,
} as const;

// ---------------------------------------------------------------------------
// Small helpers

/** Cap text and say how much was cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

/** Cap to one line (for table cells and event lines). */
function inline(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}… [+${one.length - max} chars]` : one;
}

/** Table cells: no pipes or newlines. */
function cell(text: string | number | null | undefined): string {
  if (text === null || text === undefined || text === "") return "—";
  return String(text).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

/** A fence longer than any backtick run inside the text, so content can't close it. */
function fenced(text: string, lang = ""): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "14:03:27" in the runtime's local zone. */
function hms(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "2026-11-09 14:03" in the runtime's local zone. */
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "UTC+07:00" for the runtime's zone at `ms`. */
function zoneLabel(ms: number): string {
  const off = -new Date(ms).getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** "fix-login-redirect-bug" (ascii, max 48 chars, never empty). */
function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "run";
}

/** `run-<slug>-<YYYYMMDD-HHmm>.<ext>` using the export time. */
export function exportFilename(run: RunExportData, ext: "md" | "json", exportedAt: number): string {
  const d = new Date(exportedAt);
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `run-${slugify(run.task.title)}-${ts}.${ext}`;
}

function stepRole(step: Step): string {
  return step.role ?? step.type;
}

function stepTokens(step: Step): string {
  const t = step.tokens;
  if (!t) return "—";
  return `${formatTokens(t.inputTokens)}/${formatTokens(t.outputTokens)}${t.approximate ? "*" : ""}`;
}

function stepFailed(step: Step): boolean {
  return isErrorStatus(step.status) || Boolean(step.error);
}

function isFixStep(step: Step): boolean {
  const origin = step.origin ?? "";
  return origin === "fix" || origin === "review_fix" || /(^|[-_:\s])fix([-_:\s]|$)/i.test(step.subtaskKey ?? "");
}

type ParsedCheck = { label: string; status: string; details: string };

/** `task.check` payloads arrive as a (possibly capped) JSON string. */
function parseCheck(ev: RunEvent): ParsedCheck {
  const raw = ev.payload ?? "";
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const details = p.details;
    return {
      label: typeof p.label === "string" ? p.label : ev.message ?? "check",
      status: typeof p.status === "string" ? p.status : ev.level,
      details: details === undefined || details === null ? "" : typeof details === "string" ? details : JSON.stringify(details, null, 2),
    };
  } catch {
    // Capped server-side mid-JSON: pull what we can.
    const label = /"label"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1];
    const status = /"status"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1];
    return { label: label ?? ev.message ?? "check", status: status ?? ev.level, details: raw };
  }
}

function eventLine(ev: RunEvent): string {
  const parts = [hms(ev.createdAt), ev.type];
  if (ev.subtaskKey) parts.push(`[${ev.subtaskKey}]`);
  if (ev.level && ev.level !== "info") parts.push(`(${ev.level})`);
  if (ev.message) parts.push(inline(ev.message, EXPORT_LIMITS.eventPayload));
  if (ev.payload && ev.payload !== "{}") parts.push(inline(ev.payload, EXPORT_LIMITS.eventPayload));
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Markdown

export function buildRunMarkdown(run: RunExportData, opts: RunExportOptions): string {
  const maxChars = opts.maxChars ?? EXPORT_LIMITS.maxChars;
  const { task, totals } = run;
  const models = Object.keys(totals.byModel);
  const errorCount = run.steps.filter((s) => isErrorStatus(s.status)).length;
  const durationMs = totals.durationMs ?? (task.endedAt === null ? opts.exportedAt - task.startedAt : null);

  const head: string[] = [];
  head.push(`# Run report: ${inline(task.title, 200)}`);
  head.push("");
  head.push(
    [
      `**Project:** ${cell(task.projectName)}`,
      `**Status:** ${task.status}${task.phase ? ` (${task.phase})` : ""}${task.endedAt === null ? " — still running" : ""}`,
      `**Duration:** ${formatDuration(durationMs)}`,
      `**Tokens:** ${formatTokens(totals.inputTokens)} in / ${formatTokens(totals.outputTokens)} out (${totals.calls} calls)`,
      `**Cost:** ${formatCost(totals.estimatedCost)}`,
      `**Errors:** ${errorCount}`,
      `**Models:** ${models.length ? models.join(", ") : "—"}`,
    ].join(" · ")
  );
  const meta = [
    `Task ${task._id}`,
    task.branchName ? `branch ${task.branchName}` : null,
    `started ${stamp(task.startedAt)}`,
    `exported ${stamp(opts.exportedAt)}`,
    `times ${zoneLabel(opts.exportedAt)}`,
    opts.appVersion ? `Fhara v${opts.appVersion}` : null,
  ].filter(Boolean);
  head.push("");
  head.push(`_${meta.join(" · ")}_`);

  if (task.errorMessage) {
    head.push("", "## Final error", "", fenced(clip(task.errorMessage, EXPORT_LIMITS.errorBlock)));
  }

  if (task.command) {
    head.push("", "## Instruction", "", fenced(clip(task.command, EXPORT_LIMITS.ioBlock)));
  }

  // Plan: the plan step + every subtask (one line per key, latest attempt wins).
  const planStep = run.steps.find((s) => s.type === "plan");
  const subtasks = new Map<string, Step>();
  for (const s of run.steps) if (s.type === "execution" && s.subtaskKey) subtasks.set(s.subtaskKey, s);
  if (planStep || subtasks.size) {
    head.push("", "## Plan", "");
    if (planStep) {
      const v = planStep.plans?.length ? `v${planStep.plans[planStep.plans.length - 1].version}` : "";
      head.push(`${[v, planStep.detail].filter(Boolean).join(" · ")}${planStep.output ? ` — goal: ${inline(planStep.output, 400)}` : ""}`);
      head.push("");
    }
    for (const [key, s] of subtasks) {
      const deps = s.dependencies?.length ? ` (after ${s.dependencies.join(", ")})` : "";
      const extra = [s.subtaskKind, s.origin && s.origin !== "plan" ? `origin ${s.origin}` : null].filter(Boolean).join(", ");
      head.push(`- \`${key}\` **${stepRole(s)}** — ${inline(s.title, 160)}${extra ? ` [${extra}]` : ""}${deps} → ${s.status}`);
    }
  }

  // Timeline
  head.push("", `## Timeline (${run.steps.length} steps)`, "");
  head.push("| # | Role | Step | Status | Duration | Tokens in/out |");
  head.push("|---|---|---|---|---|---|");
  run.steps.forEach((s, i) => {
    const title = `${s.title}${s.attempt && s.attempt > 1 ? ` (try ${s.attempt})` : ""}`;
    const dur = s.durationMs !== undefined && s.durationMs > 0 ? formatDuration(s.durationMs) : "—";
    head.push(`| ${i + 1} | ${cell(stepRole(s))} | ${cell(inline(title, 120))} | ${cell(s.status)} | ${dur} | ${stepTokens(s)} |`);
  });
  if (run.steps.some((s) => s.tokens?.approximate)) head.push("", "\\* tokens matched to the step by agent and time window.");
  if (totals.unattributed) {
    head.push(
      "",
      `${formatTokens(totals.unattributed.inputTokens)} in / ${formatTokens(totals.unattributed.outputTokens)} out could not be tied to a step.`
    );
  }

  // Failures: steps with an error, failed status, or fix origin.
  const problem = run.steps
    .map((s, i) => ({ s, n: i + 1 }))
    .filter(({ s }) => s.type !== "final" && (stepFailed(s) || isFixStep(s)));
  const failureBlocks: string[] = [];
  for (const { s, n } of problem) {
    const failed = stepFailed(s);
    const lines = [`### #${n} ${stepRole(s)} — ${inline(s.title, 160)} (${s.status}${isFixStep(s) ? ", fix" : ""})`];
    if (s.detail) lines.push("", inline(s.detail, 600));
    if (s.error) lines.push("", "Error:", fenced(clip(s.error, EXPORT_LIMITS.errorBlock)));
    if (s.input) lines.push("", "Input:", fenced(clip(s.input, EXPORT_LIMITS.ioBlock)));
    if (s.output) lines.push("", "Output:", fenced(clip(s.output, EXPORT_LIMITS.ioBlock)));
    if (!failed && !s.input && !s.output) continue;
    failureBlocks.push(lines.join("\n"));
  }

  // Checks
  const checks = run.events.filter((e) => e.type === "task.check").map(parseCheck);
  const failedChecks = checks.filter((c) => c.status === "failed");
  const checkLines: string[] = [];
  if (checks.length) {
    checkLines.push("", `## Checks (${checks.length}, ${failedChecks.length} failed)`, "");
    for (const c of checks) {
      checkLines.push(`- **${inline(c.label, 120)}** — ${c.status}`);
      if (c.details) {
        const d = clip(c.details, EXPORT_LIMITS.checkDetails);
        if (c.status === "failed" || d.includes("\n")) checkLines.push("", fenced(d));
        else checkLines.push(`  ${inline(d, EXPORT_LIMITS.checkDetails)}`);
      }
    }
  }

  // Hand-offs + agents
  const tail: string[] = [];
  if (run.handoffs.length) {
    tail.push("", "## Hand-offs", "");
    for (const h of run.handoffs) tail.push(`- ${h.from} → ${h.to}${h.count > 1 ? ` ×${h.count}` : ""}`);
    const delegations = run.edges.filter((e) => e.type === "delegation");
    for (const d of delegations.slice(0, 40)) {
      tail.push(`- delegation ${d.fromRole ?? d.from} → ${d.toRole ?? d.to}${d.decision ? ` (${d.decision})` : ""}${d.reason ? `: ${inline(d.reason, 200)}` : ""}`);
    }
    if (delegations.length > 40) tail.push(`- … ${delegations.length - 40} more delegations omitted`);
  }
  if (totals.byAgent.length) {
    tail.push("", "## Agents", "", "| Role | Calls | Tokens in/out | Cost |", "|---|---|---|---|");
    for (const a of totals.byAgent) {
      tail.push(`| ${cell(a.role)} | ${a.calls} | ${formatTokens(a.inputTokens)}/${formatTokens(a.outputTokens)} | ${formatCost(a.estimatedCost)} |`);
    }
  }

  const sections = (failureBlocks.length ? ["", "## Failures and fixes", "", failureBlocks.join("\n\n")] : []);
  const body = [...head, ...sections, ...checkLines, ...tail].join("\n");

  // Events: last 150, trimmed further (oldest first) to fit the budget.
  const evAll = run.events;
  let ev = evAll.slice(-EXPORT_LIMITS.events);
  const render = (list: RunEvent[]) => {
    const dropped = evAll.length - list.length;
    const notes: string[] = [];
    if (run.eventsTruncated) notes.push("older events were not loaded by the server");
    if (dropped > 0) notes.push(`${dropped} earlier events omitted`);
    const header = `## Events (last ${list.length} of ${evAll.length}${run.eventsTruncated ? "+" : ""})`;
    return ["", "", header, "", ...(notes.length ? [`_[truncated: ${notes.join("; ")}]_`, ""] : []), fenced(list.map(eventLine).join("\n") || "(none)")].join("\n");
  };
  let events = render(ev);
  while (body.length + events.length > maxChars && ev.length > 0) {
    // Drop roughly the overflow's worth of lines, at least 5 at a time.
    const over = body.length + events.length - maxChars;
    const avg = Math.max(40, events.length / Math.max(1, ev.length));
    ev = ev.slice(Math.max(5, Math.ceil(over / avg)));
    events = render(ev);
  }

  let doc = `${body}${evAll.length ? events : ""}\n`;
  if (doc.length > maxChars) {
    // Events alone weren't enough: hard-cut the rest and say so.
    const marker = `\n\n… [report truncated: ${doc.length - maxChars} chars cut to stay under ${maxChars}]\n`;
    doc = doc.slice(0, maxChars - marker.length) + marker;
  }
  return doc;
}

// ---------------------------------------------------------------------------
// JSON

export function buildRunJson(run: RunExportData, opts: RunExportOptions): string {
  return JSON.stringify(
    {
      exportedAt: new Date(opts.exportedAt).toISOString(),
      ...(opts.appVersion ? { appVersion: opts.appVersion } : {}),
      ...run,
    },
    null,
    2
  );
}
