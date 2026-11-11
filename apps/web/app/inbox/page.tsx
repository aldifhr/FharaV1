"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import Link from "next/link";
import { ArrowUpRight, Check, Inbox as InboxIcon } from "lucide-react";
import IconRail from "@/components/IconRail";
import { roleLabel } from "@/lib/agentRoles";
import { useToast } from "@/components/Toasts";

const KIND_LABEL: Record<string, string> = {
  apply_changes: "Apply changes",
  git_push: "Git push",
  run_command: "Run command",
  plan: "Review plan",
};

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-3 flex items-baseline gap-2 text-[13px] font-medium text-ink-2">
        {title}
        <span className="tabular-nums text-ink-3">{count}</span>
      </h2>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">{children}</ul>
    </section>
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
  // O4: issues the user opened with the intake label, waiting as drafts.
  const issueDrafts = useQuery(api.issueIntake.listDrafts, {});
  const startDraft = useMutation(api.issueIntake.start);
  const dismissDraft = useMutation(api.issueIntake.dismiss);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  // O6: each decision is bound to what this screen showed (fingerprint) and
  // when it first showed it; the backend refuses a stale or changed one.
  const shownAt = useRef(new Map<string, number>());
  const shown = (a: { _id: string; fingerprint?: string }) => {
    const key = `${a._id}:${a.fingerprint ?? ""}`;
    if (!shownAt.current.has(key)) shownAt.current.set(key, Date.now());
    return a.fingerprint ? { fingerprint: a.fingerprint, shownAt: shownAt.current.get(key)! } : {};
  };

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
  const anything =
    inbox !== undefined &&
    (total > 0 || inbox.approvals.length + inbox.notifications.length + inbox.tasks.length + inbox.failed.length + inbox.questions.length + inbox.pushes.length + drafts.length > 0);

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <header>
            <h1 className="text-[26px] font-semibold tracking-tight">Inbox</h1>
            <p className="mt-1 text-[15px] text-ink-2">
              {inbox === undefined
                ? "Loading…"
                : total
                  ? `${total} ${total === 1 ? "thing waits" : "things wait"} on you`
                  : "Nothing waits on you"}
            </p>
          </header>

          {inbox === undefined ? (
            <div className="mt-10 space-y-3" aria-label="Loading inbox">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-16 rounded-xl bg-hover" />
              ))}
            </div>
          ) : !anything ? (
            <div className="mt-16 flex flex-col items-center text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-hover text-ink-3">
                <InboxIcon size={18} />
              </span>
              <p className="mt-4 text-[14px] text-ink-2">You're all caught up.</p>
              <p className="mt-1 text-[13px] text-ink-3">Approvals, questions and failed tasks show up here.</p>
            </div>
          ) : (
            <>
              {inbox.approvals.length > 0 && (
                <Section title="Approvals" count={inbox.approvals.length}>
                  {inbox.approvals.map((a) => (void shown(a), (
                    <li key={a._id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] leading-snug">{a.summary}</p>
                        <p className="mt-0.5 truncate text-[12.5px] text-ink-3">
                          {KIND_LABEL[a.kind] ?? a.kind}
                          {" · "}
                          <Link href={`/chats/${a.projectId}`} className="hover:text-ink">{a.projectName}</Link>
                          {a.taskTitle ? ` · ${a.taskTitle}` : ""}
                          {a.requestedByAgentName ? ` · ${roleLabel(a.requestedByAgentName)}` : ""}
                        </p>
                        {a.kind === "run_command" && typeof (a.payload as any)?.command === "string" && (
                          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-canvas px-3 py-1.5 font-mono text-[12.5px] text-ink">
                            {(a.payload as any).command}
                          </pre>
                        )}
                      </div>
                      {a.kind === "run_command" ? (
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                          <button
                            type="button"
                            disabled={busy === a._id}
                            onClick={() => void decide(a, "deny")}
                            className="rounded-lg px-3 py-2 text-[13px] sm:px-2.5 sm:py-1 text-ink-2 transition hover:bg-hover disabled:opacity-50"
                          >
                            Deny
                          </button>
                          {a.offerAlways === true && !(a.payload as any)?.danger && (
                            <button
                              type="button"
                              disabled={busy === a._id}
                              onClick={() => void decide(a, "always")}
                              className="rounded-lg border border-line px-3 py-2 text-[13px] sm:px-2.5 sm:py-1 text-ink transition hover:bg-hover disabled:opacity-50"
                            >
                              Always allow
                            </button>
                          )}
                          {a.offerAlways === true && !(a.payload as any)?.danger && (
                            <button
                              type="button"
                              disabled={busy === a._id}
                              onClick={() => void decide(a, "always_exact")}
                              className="rounded-lg border border-line px-3 py-2 text-[13px] sm:px-2.5 sm:py-1 text-ink transition hover:bg-hover disabled:opacity-50"
                            >
                              Always allow this exact command
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy === a._id}
                            onClick={() => void decide(a, "allow")}
                            className="inline-flex items-center gap-1 rounded-lg bg-ink px-3 py-2 text-[13px] sm:px-2.5 sm:py-1 font-medium text-canvas transition hover:opacity-90 disabled:opacity-50"
                          >
                            <Check size={13} /> Allow
                          </button>
                        </div>
                      ) : (
                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          disabled={busy === a._id}
                          onClick={() => void act(a, reject, "Rejected")}
                          className="rounded-lg px-3 py-2 text-[13px] sm:px-2.5 sm:py-1 text-ink-2 transition hover:bg-hover disabled:opacity-50"
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          disabled={busy === a._id}
                          onClick={() => void act(a, approve, "Approved")}
                          className="inline-flex items-center gap-1 rounded-lg bg-ink px-3 py-2 text-[13px] sm:px-2.5 sm:py-1 font-medium text-canvas transition hover:opacity-90 disabled:opacity-50"
                        >
                          <Check size={13} /> Approve
                        </button>
                      </div>
                      )}
                    </li>
                  )))}
                </Section>
              )}

              {inbox.notifications.length > 0 && (
                <Section title="Pull requests" count={inbox.notifications.length}>
                  {inbox.notifications.map((n) => (
                    <li key={n._id}>
                      <Link href={`/chats/${n.projectId}?task=${n.taskId}`} className="flex items-center gap-3 px-4 py-3 transition hover:bg-hover">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px]">{n.title}</p>
                          <p className="truncate text-[12.5px] text-ink-3">
                            {n.projectName}
                            {n.detail ? ` · ${n.detail}` : ""}
                          </p>
                        </div>
                        <ArrowUpRight size={14} className="shrink-0 text-ink-3" />
                      </Link>
                    </li>
                  ))}
                </Section>
              )}

              {inbox.questions.length > 0 && (
                <Section title="Questions" count={inbox.questions.length}>
                  {inbox.questions.map((q) => (
                    <li key={q.key}>
                      <Link href={`/chats/${q.projectId}${q.taskId ? `?task=${q.taskId}` : ""}`} className="flex items-center gap-3 px-4 py-3 transition hover:bg-hover">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px]">{q.title}</p>
                          <p className="truncate text-[12.5px] text-ink-3">
                            {`${q.agentRole ? roleLabel(q.agentRole) : "System"} · `}
                            {q.projectName}
                          </p>
                        </div>
                        <ArrowUpRight size={14} className="shrink-0 text-ink-3" />
                      </Link>
                    </li>
                  ))}
                </Section>
              )}

              {inbox.pushes.length > 0 && (
                <Section title="Ready to push" count={inbox.pushes.length}>
                  {inbox.pushes.map((p) => (
                    <li key={p.key}>
                      <Link href={`/chats/${p.projectId}${p.taskId ? `?task=${p.taskId}` : ""}`} className="flex items-center gap-3 px-4 py-3 transition hover:bg-hover">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px]">{p.title}</p>
                          <p className="truncate text-[12.5px] text-ink-3">
                            {p.projectName}
                            {p.note ? ` · ${p.note}` : ""}
                          </p>
                        </div>
                        <ArrowUpRight size={14} className="shrink-0 text-ink-3" />
                      </Link>
                    </li>
                  ))}
                </Section>
              )}

              {drafts.length > 0 && (
                <Section title="From GitHub issues" count={drafts.length}>
                  {drafts.map((d) => (
                    <li key={d._id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] leading-snug">
                          #{d.issueNumber} {d.title}
                        </p>
                        <p className="mt-0.5 truncate text-[12.5px] text-ink-3">
                          Draft task · {d.projectName} ·{" "}
                          {d.url ? (
                            <a href={d.url} target="_blank" rel="noreferrer" className="hover:text-ink">
                              {d.repoFullName}#{d.issueNumber}
                            </a>
                          ) : (
                            `${d.repoFullName}#${d.issueNumber}`
                          )}
                        </p>
                        {d.preflight?.looksDone && (
                          <p className="mt-1 text-[12.5px] text-ink-2">Looks done already: {d.preflight.evidence.join("; ")}</p>
                        )}
                        {d.preflight === null && <p className="mt-1 text-[12.5px] text-ink-3">Checking whether it is already done…</p>}
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          disabled={busy === d._id}
                          onClick={() => void dismissIssue(d._id)}
                          className="rounded-lg px-3 py-2 text-[13px] sm:px-2.5 sm:py-1 text-ink-2 transition hover:bg-hover disabled:opacity-50"
                        >
                          Dismiss
                        </button>
                        <button
                          type="button"
                          disabled={busy === d._id}
                          onClick={() => void startIssue(d._id, Boolean(d.preflight?.looksDone))}
                          className="inline-flex items-center gap-1 rounded-lg bg-ink px-3 py-2 text-[13px] sm:px-2.5 sm:py-1 font-medium text-canvas transition hover:opacity-90 disabled:opacity-50"
                        >
                          {d.preflight?.looksDone ? "Start anyway" : "Start"}
                        </button>
                      </div>
                    </li>
                  ))}
                </Section>
              )}

              {inbox.tasks.length > 0 && (
                <Section title="Drafts to review" count={inbox.tasks.length}>
                  {inbox.tasks.map((t) => (
                    <li key={t._id}>
                      <Link href={`/chats/${t.projectId}?task=${t._id}`} className="flex items-center gap-3 px-4 py-3 transition hover:bg-hover">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-3" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px]">{t.title}</p>
                          <p className="truncate text-[12.5px] text-ink-3">Waiting for approval · {t.projectName}</p>
                        </div>
                        <ArrowUpRight size={14} className="shrink-0 text-ink-3" />
                      </Link>
                    </li>
                  ))}
                </Section>
              )}

              {inbox.failed.length > 0 && (
                <Section title="Recent failures · not waiting on you" count={inbox.failed.length}>
                  {inbox.failed.map((t) => (
                    <li key={t._id}>
                      <Link href={`/chats/${t.projectId}?task=${t._id}`} className="flex items-center gap-3 px-4 py-3 transition hover:bg-hover">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px]">{t.title}</p>
                          <p className="truncate text-[12.5px] text-ink-3">Failed · {t.projectName}</p>
                        </div>
                        <ArrowUpRight size={14} className="shrink-0 text-ink-3" />
                      </Link>
                    </li>
                  ))}
                </Section>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
