
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@fhara/runtime/react";
import { api } from "@fhara/runtime/api";
import { Link } from "@/lib/spaRouter";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  ClipboardList,
  Clock3,
  GitBranch,
  GitPullRequest,
  Inbox as InboxIcon,
  ListChecks,
  MessageSquare,
  Upload,
} from "lucide-react";
import Sidebar from "@/components/Sidebar";
import { PageHeader } from "@/components/ui/page-header";
import { StatusTag } from "@/components/ui/status-tag";
import { roleLabel } from "@/lib/agentRoles";
import { useToast } from "@/components/Toasts";
import McpDraftsSection from "@/components/inbox/McpDraftsSection";
import { projectHref } from "@/lib/threadTree";
import { requestThread } from "@/lib/pendingThread";

const KIND_LABEL: Record<string, string> = {
  apply_changes: "Apply changes",
  git_push: "Git push",
  run_command: "Run command",
  run_unconfined: "Run without the sandbox",
  plan: "Review plan",
  merge_pr: "Merge pull request",
};

const QUIET_ACTION =
  "inline-flex h-8 items-center justify-center rounded-field px-2.5 text-[12.5px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40";
const OUTLINE_ACTION =
  "inline-flex h-8 items-center justify-center rounded-field border border-line bg-panel px-2.5 text-[12.5px] text-ink outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40";
const PRIMARY_ACTION =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-field bg-ink px-2.5 text-[12.5px] font-medium text-canvas outline-none transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40";

function commandOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { command?: unknown }).command;
  return typeof value === "string" ? value : null;
}

function isDangerous(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return Boolean((payload as { danger?: unknown }).danger);
}

function Section({
  title,
  count,
  tone,
  icon,
  children,
}: {
  title: string;
  count: number;
  tone?: "warn" | "danger";
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span
          aria-hidden="true"
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-inset ${
            tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-ink-3"
          }`}
        >
          {icon ?? <InboxIcon size={14} />}
        </span>
        <h3 className="text-[13.5px] font-medium text-ink">{title}</h3>
        <span className="ml-auto text-[12px] tabular-nums text-ink-3">{count}</span>
      </div>
      <ul className="divide-y divide-line">{children}</ul>
    </section>
  );
}

function Group({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-caption">{title}</h2>
        <p className="text-[12px] text-ink-3">{description}</p>
      </div>
      <div className="grid gap-4">{children}</div>
    </section>
  );
}

function Row({
  href,
  title,
  meta,
  onClick,
  dot,
}: {
  href: string;
  title: string;
  meta: ReactNode;
  onClick?: () => void;
  dot?: "danger" | "muted";
}) {
  return (
    <li>
      <Link
        href={href}
        onClick={onClick}
        className="group flex items-center gap-3 px-4 py-3 outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/30"
      >
        {dot && (
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 shrink-0 ${dot === "danger" ? "bg-destructive" : "bg-ink-3"}`}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] text-ink">{title}</p>
          <p className="mt-0.5 truncate text-[12px] text-ink-3">{meta}</p>
        </div>
        <ArrowUpRight size={14} aria-hidden="true" className="shrink-0 text-ink-3 transition group-hover:text-ink" />
      </Link>
    </li>
  );
}

/**
 * Inbox: all notifications, across projects. What waits on the user comes
 * first (approvals, questions, pushes, pull requests, drafts to review);
 * its count is the server's `waitingCount`, the same number as the sidebar
 * "Needs you" (shell.ts). Recent failed tasks follow as information and
 * are never counted as waiting.
 */
export default function InboxPage() {
  const inbox = useQuery(api.inbox.list, {});
  const approve = useMutation(api.approvals.approve);
  const reject = useMutation(api.approvals.reject);
  const respond = useMutation(api.commandApprovals.respond);
  const issueDrafts = useQuery(api.issueIntake.listDrafts, {});
  const startDraft = useMutation(api.issueIntake.start);
  const dismissDraft = useMutation(api.issueIntake.dismiss);
  const mcpDrafts = useQuery(api.taskDrafts.listVisible, {});
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  // O6: each decision is bound to what this screen showed (fingerprint) and
  // when it first showed it; the backend refuses a stale or changed one.
  const shownAt = useRef(new Map<string, number>());
  const shown = useCallback((a: { _id: string; fingerprint?: string }) => {
    const key = `${a._id}:${a.fingerprint ?? ""}`;
    if (!shownAt.current.has(key)) shownAt.current.set(key, Date.now());
    return a.fingerprint ? { fingerprint: a.fingerprint, shownAt: shownAt.current.get(key)! } : {};
  }, []);
  useEffect(() => {
    for (const a of inbox?.approvals ?? []) shown(a);
  }, [inbox?.approvals, shown]);

  const act = async (a: { _id: string; fingerprint?: string }, fn: typeof approve, done: string) => {
    const id = a._id;
    setBusy(id);
    try {
      await fn({ approvalId: id as never, ...shown(a) });
      toast("success", done);
    } catch (err) {
      toast("error", "Couldn't update the approval", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const decide = async (a: { _id: string; fingerprint?: string }, decision: "allow" | "always" | "always_exact" | "deny") => {
    const id = a._id;
    setBusy(id);
    try {
      const res = await respond({ approvalId: id as never, decision, ...shown(a) });
      toast(
        "success",
        res.decision === "deny"
          ? "Denied"
          : res.decision === "always"
            ? "Always allowed for this project"
            : res.decision === "always_exact"
              ? "This exact command is always allowed for this project"
              : "Allowed"
      );
    } catch (err) {
      toast("error", "Couldn't update the approval", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const startIssue = async (id: string, confirmDone: boolean) => {
    setBusy(id);
    try {
      await startDraft({ draftId: id as never, confirmDone });
      toast("success", "Task started");
    } catch (err) {
      toast("error", "Couldn't start the task", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };
  const dismissIssue = async (id: string) => {
    setBusy(id);
    try {
      await dismissDraft({ draftId: id as never });
    } catch (err) {
      toast("error", "Couldn't dismiss the draft", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const total = inbox?.waitingCount ?? 0;
  const drafts = issueDrafts ?? [];
  const loaded = inbox !== undefined && issueDrafts !== undefined && mcpDrafts !== undefined;
  const anything =
    loaded &&
    (total > 0 || inbox!.approvals.length + inbox!.notifications.length + inbox!.tasks.length + inbox!.failed.length + inbox!.questions.length + inbox!.options.length + inbox!.pushes.length + drafts.length + mcpDrafts!.length > 0);
  const approvals = inbox?.approvals.length ?? 0;
  const questions = (inbox?.questions.length ?? 0) + (inbox?.options.length ?? 0);
  const draftCount = drafts.length + (mcpDrafts?.length ?? 0) + (inbox?.tasks.length ?? 0);
  const needsYou = approvals + questions + (inbox?.pushes.length ?? 0) + draftCount;
  const updates = (inbox?.notifications.length ?? 0) + (inbox?.failed.length ?? 0);
  const stats = [
    {
      label: "Waiting",
      value: total,
      note: total > 0 ? "for a decision" : "all clear",
      icon: <Clock3 size={13} />,
      tone: total > 0 ? "text-warn" : "",
      title: "Items waiting for you; the server's count, same as the sidebar",
    },
    { label: "Approvals", value: approvals, note: "to allow or reject", icon: <Check size={13} />, tone: "", title: "Approvals waiting on you" },
    { label: "Questions", value: questions, note: "and options", icon: <MessageSquare size={13} />, tone: "", title: "Questions and option choices waiting on you" },
    { label: "Drafts", value: draftCount, note: "to start or review", icon: <ClipboardList size={13} />, tone: "", title: "Issue, MCP and task drafts waiting on you" },
  ];

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-8 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-[1100px]">
          <PageHeader
            eyebrow="Across all projects"
            title="Inbox"
            leading={
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-field border border-line bg-panel text-ink-2">
                <InboxIcon size={17} />
              </span>
            }
            status={
              inbox
                ? {
                    tone: total > 0 ? "warn" : "ok",
                    label: total > 0 ? `${total} waiting` : "All clear",
                    title: total > 0 ? "Items waiting for your decision" : "Nothing waiting for you",
                  }
                : null
            }
            meta={
              <>
                <p className="text-[15px] text-ink-2">Approvals and questions that need you, plus updates from your projects.</p>
                <p className="sr-only" role="status">
                  {total > 0 ? `${total} items waiting` : "All clear"}
                </p>
              </>
            }
          />

          {!loaded || !inbox ? (
            <div className="mt-8 space-y-3" role="status" aria-label="Loading inbox">
              <span className="sr-only">Loading inbox</span>
              {[0, 1, 2].map((index) => (
                <div key={index} aria-hidden="true" className="h-16 rounded-card bg-hover" />
              ))}
            </div>
          ) : !anything ? (
            <div className="mt-20 flex flex-col items-center text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-card border border-line bg-panel text-ink-3">
                <InboxIcon size={20} />
              </span>
              <p className="mt-4 text-[15px] font-medium text-ink">You're all caught up.</p>
              <p className="mt-1 text-[13px] text-ink-3">Approvals, questions and updates from your projects show up here.</p>
            </div>
          ) : (
            <>
              <section
                aria-label="Inbox metrics"
                className="mt-6 grid grid-cols-2 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel shadow-card sm:divide-y-0 sm:divide-x lg:grid-cols-4"
              >
                {stats.map((metric) => (
                  <div key={metric.label} className="p-4 sm:p-5" title={metric.title}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-caption">{metric.label}</span>
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-inset text-ink-3">{metric.icon}</span>
                    </div>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className={`text-[28px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${metric.tone || "text-ink"}`}>
                        {metric.value}
                      </span>
                      <span className="truncate text-[12px] text-ink-3">{metric.note}</span>
                    </div>
                  </div>
                ))}
              </section>

              {needsYou > 0 && (
                <Group title="Needs you" description="Decisions and drafts waiting on you">
                {inbox.approvals.length > 0 && (
                  <Section title="Approvals" count={inbox.approvals.length} tone="warn" icon={<Check size={14} />}>
                    {inbox.approvals.map((a) => {
                      const command = commandOf(a.payload);
                      const shell = a.kind === "run_command" || a.kind === "run_unconfined";
                      const risky = isDangerous(a.payload);
                      return (
                        <li key={a._id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
                          <div className="min-w-0 flex-1">
                            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                              <StatusTag tone={risky ? "danger" : "warn"}>{KIND_LABEL[a.kind] ?? a.kind}</StatusTag>
                              {risky && (
                                <StatusTag tone="danger" title="The worker flagged this command as dangerous">
                                  Careful
                                </StatusTag>
                              )}
                            </div>
                            <p className="text-[13.5px] leading-snug text-ink">{a.summary}</p>
                            <p className="mt-1 truncate text-[12px] text-ink-3">
                              <Link href={projectHref(a.projectId)} className="text-ink-2 underline decoration-line underline-offset-2 transition hover:text-ink">
                                {a.projectName}
                              </Link>
                              {a.taskTitle ? ` · ${a.taskTitle}` : ""}
                              {a.requestedByAgentName ? ` · by ${roleLabel(a.requestedByAgentName)}` : ""}
                            </p>
                            {shell && command && (
                              <pre aria-label="Requested command" className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-field border border-line bg-inset px-3 py-1.5 font-mono text-[12px] text-ink">
                                {command}
                              </pre>
                            )}
                          </div>
                          <div className="flex shrink-0 flex-wrap items-center gap-2">
                            {shell ? (
                              <>
                                <button type="button" disabled={busy === a._id} onClick={() => void decide(a, "deny")} className={QUIET_ACTION}>
                                  Deny
                                </button>
                                {a.offerAlways === true && !risky && (
                                  <button type="button" disabled={busy === a._id} onClick={() => void decide(a, "always")} className={OUTLINE_ACTION}>
                                    Always allow
                                  </button>
                                )}
                                {a.offerAlways === true && !risky && (
                                  <button type="button" disabled={busy === a._id} onClick={() => void decide(a, "always_exact")} className={OUTLINE_ACTION}>
                                    Always allow this exact command
                                  </button>
                                )}
                                <button type="button" disabled={busy === a._id} onClick={() => void decide(a, "allow")} className={PRIMARY_ACTION}>
                                  <Check size={13} aria-hidden="true" /> Allow
                                </button>
                              </>
                            ) : (
                              <>
                                <button type="button" disabled={busy === a._id} onClick={() => void act(a, reject, "Rejected")} className={QUIET_ACTION}>
                                  Reject
                                </button>
                                <button type="button" disabled={busy === a._id} onClick={() => void act(a, approve, "Approved")} className={PRIMARY_ACTION}>
                                  <Check size={13} aria-hidden="true" /> Approve
                                </button>
                              </>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </Section>
                )}

                {inbox.questions.length > 0 && (
                  <Section title="Questions" count={inbox.questions.length} icon={<MessageSquare size={14} />}>
                    {inbox.questions.map((q) => (
                      <Row
                        key={q.key}
                        href={projectHref(q.projectId)}
                        onClick={() => q.taskId && requestThread(q.projectId, q.taskId)}
                        title={q.title}
                        meta={`${q.agentRole ? roleLabel(q.agentRole) : "System"} · ${q.projectName}`}
                      />
                    ))}
                  </Section>
                )}

                {inbox.options.length > 0 && (
                  <Section title="Options to review" count={inbox.options.length} icon={<ListChecks size={14} />}>
                    {inbox.options.map((o) => (
                      <Row
                        key={o.key}
                        href={projectHref(o.projectId)}
                        onClick={() => o.taskId && requestThread(o.projectId, o.taskId)}
                        title={o.title}
                        meta={o.note ? `${o.projectName} · ${o.note}` : o.projectName}
                      />
                    ))}
                  </Section>
                )}

                {inbox.pushes.length > 0 && (
                  <Section title="Ready to push" count={inbox.pushes.length} icon={<Upload size={14} />}>
                    {inbox.pushes.map((p) => (
                      <Row
                        key={p.key}
                        href={projectHref(p.projectId)}
                        onClick={() => p.taskId && requestThread(p.projectId, p.taskId)}
                        title={p.title}
                        meta={p.note ? `${p.projectName} · ${p.note}` : p.projectName}
                      />
                    ))}
                  </Section>
                )}

                {drafts.length > 0 && (
                  <Section title="From GitHub issues" count={drafts.length} icon={<GitBranch size={14} />}>
                    {drafts.map((d) => (
                      <li key={d._id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                            <StatusTag tone="neutral">GitHub issue</StatusTag>
                            {d.preflight?.looksDone && <StatusTag tone="warn">Looks done</StatusTag>}
                            {d.preflight === null && <StatusTag tone="neutral">Checking…</StatusTag>}
                          </div>
                          <p className="text-[13.5px] leading-snug text-ink">
                            #{d.issueNumber} {d.title}
                          </p>
                          <p className="mt-1 truncate text-[12px] text-ink-3">
                            Draft for {d.projectName} ·{" "}
                            {d.url ? (
                              <a href={d.url} target="_blank" rel="noreferrer" className="text-ink-2 underline decoration-line underline-offset-2 transition hover:text-ink">
                                {d.repoFullName}#{d.issueNumber}
                              </a>
                            ) : (
                              `${d.repoFullName}#${d.issueNumber}`
                            )}
                          </p>
                          {d.preflight?.looksDone && (
                            <p className="mt-1 text-[12px] text-ink-2">Evidence: {d.preflight.evidence.join("; ")}</p>
                          )}
                          {d.preflight === null && <p className="mt-1 text-[12px] text-ink-3">Checking whether it is already done…</p>}
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          <button type="button" disabled={busy === d._id} onClick={() => void dismissIssue(d._id)} className={QUIET_ACTION}>
                            Dismiss
                          </button>
                          <button
                            type="button"
                            disabled={busy === d._id}
                            onClick={() => void startIssue(d._id, Boolean(d.preflight?.looksDone))}
                            className={PRIMARY_ACTION}
                          >
                            {d.preflight?.looksDone ? "Start anyway" : "Start"}
                          </button>
                        </div>
                      </li>
                    ))}
                  </Section>
                )}

                <McpDraftsSection drafts={mcpDrafts} />

                {inbox.tasks.length > 0 && (
                  <Section title="Drafts to review" count={inbox.tasks.length} icon={<ClipboardList size={14} />}>
                    {inbox.tasks.map((t) => (
                      <Row
                        key={t._id}
                        href={projectHref(t.projectId)}
                        onClick={() => requestThread(t.projectId, t._id)}
                        title={t.title}
                        meta={`Waiting for approval · ${t.projectName}`}
                        dot="muted"
                      />
                    ))}
                  </Section>
                )}
              </Group>
              )}

              {updates > 0 && (
                <Group title="Updates" description="What happened in your projects">
                {inbox.notifications.length > 0 && (
                  <Section title="Pull requests" count={inbox.notifications.length} icon={<GitPullRequest size={14} />}>
                    {inbox.notifications.map((n) => (
                      <Row
                        key={n._id}
                        href={projectHref(n.projectId)}
                        onClick={() => n.taskId && requestThread(n.projectId, n.taskId)}
                        title={n.title}
                        meta={n.detail ? `${n.projectName} · ${n.detail}` : n.projectName}
                      />
                    ))}
                  </Section>
                )}

                {inbox.failed.length > 0 && (
                  <Section title="Recent failures" count={inbox.failed.length} tone="danger" icon={<AlertTriangle size={14} />}>
                    {inbox.failed.map((t) => (
                      <Row
                        key={t._id}
                        href={projectHref(t.projectId)}
                        onClick={() => requestThread(t.projectId, t._id)}
                        title={t.title}
                        meta={`Failed · ${t.projectName}`}
                        dot="danger"
                      />
                    ))}
                  </Section>
                )}
              </Group>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
