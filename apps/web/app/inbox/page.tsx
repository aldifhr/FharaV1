"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import Link from "next/link";
import { ArrowUpRight, Check, Inbox as InboxIcon } from "lucide-react";
import IconRail from "@/components/IconRail";
import InitialAvatar from "@/components/InitialAvatar";
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
 * Inbox: everything that waits on the user, across projects. Approvals
 * first (they block work), then stopped tasks, then agents asking.
 */
export default function InboxPage() {
  const inbox = useQuery(api.inbox.list, {});
  const approve = useMutation(api.approvals.approve);
  const reject = useMutation(api.approvals.reject);
  const respond = useMutation(api.commandApprovals.respond);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (id: string, fn: typeof approve, done: string) => {
    setBusy(id);
    try {
      await fn({ approvalId: id as never });
      toast("success", done);
    } catch (err) {
      toast("error", "Couldn't update the approval", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const decide = async (id: string, decision: "allow" | "always" | "deny") => {
    setBusy(id);
    try {
      const res = await respond({ approvalId: id as never, decision });
      toast("success", res.decision === "deny" ? "Denied" : res.decision === "always" ? "Always allowed for this project" : "Allowed");
    } catch (err) {
      toast("error", "Couldn't update the approval", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const total = inbox ? inbox.approvals.length + inbox.tasks.length + inbox.agents.length : 0;

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
                <div key={i} className="h-16 animate-pulse rounded-xl bg-hover" />
              ))}
            </div>
          ) : total === 0 ? (
            <div className="mt-16 flex flex-col items-center text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-hover text-ink-3">
                <InboxIcon size={18} />
              </span>
              <p className="mt-4 text-[14px] text-ink-2">You're all caught up.</p>
              <p className="mt-1 text-[13px] text-ink-3">Approvals and stopped tasks show up here.</p>
            </div>
          ) : (
            <>
              {inbox.approvals.length > 0 && (
                <Section title="Approvals" count={inbox.approvals.length}>
                  {inbox.approvals.map((a) => (
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
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            disabled={busy === a._id}
                            onClick={() => void decide(a._id, "deny")}
                            className="rounded-lg px-2.5 py-1 text-[13px] text-ink-2 transition hover:bg-hover disabled:opacity-50"
                          >
                            Deny
                          </button>
                          {a.offerAlways === true && !(a.payload as any)?.danger && (
                            <button
                              type="button"
                              disabled={busy === a._id}
                              onClick={() => void decide(a._id, "always")}
                              className="rounded-lg border border-line px-2.5 py-1 text-[13px] text-ink transition hover:bg-hover disabled:opacity-50"
                            >
                              Always allow
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy === a._id}
                            onClick={() => void decide(a._id, "allow")}
                            className="inline-flex items-center gap-1 rounded-lg bg-ink px-2.5 py-1 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-50"
                          >
                            <Check size={13} /> Allow
                          </button>
                        </div>
                      ) : (
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          disabled={busy === a._id}
                          onClick={() => void act(a._id, reject, "Rejected")}
                          className="rounded-lg px-2.5 py-1 text-[13px] text-ink-2 transition hover:bg-hover disabled:opacity-50"
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          disabled={busy === a._id}
                          onClick={() => void act(a._id, approve, "Approved")}
                          className="inline-flex items-center gap-1 rounded-lg bg-ink px-2.5 py-1 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-50"
                        >
                          <Check size={13} /> Approve
                        </button>
                      </div>
                      )}
                    </li>
                  ))}
                </Section>
              )}

              {inbox.tasks.length > 0 && (
                <Section title="Stopped tasks" count={inbox.tasks.length}>
                  {inbox.tasks.map((t) => (
                    <li key={t._id}>
                      <Link href={`/chats/${t.projectId}`} className="flex items-center gap-3 px-4 py-3 transition hover:bg-hover">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.status === "failed" ? "bg-red-500" : "bg-orange-500"}`} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px]">{t.title}</p>
                          <p className="truncate text-[12.5px] text-ink-3">
                            {t.status === "failed" ? "Failed" : "Waiting for approval"} · {t.projectName}
                          </p>
                        </div>
                        <ArrowUpRight size={14} className="shrink-0 text-ink-3" />
                      </Link>
                    </li>
                  ))}
                </Section>
              )}

              {inbox.agents.length > 0 && (
                <Section title="Agents asking" count={inbox.agents.length}>
                  {inbox.agents.map((a) => (
                    <li key={a._id} className="flex items-center gap-3 px-4 py-3">
                      <InitialAvatar agent avatarParams={a.avatarParams} name={roleLabel(a.role)} size={28} status="needs_you" />
                      <p className="min-w-0 flex-1 truncate text-[14px]">
                        <span className="font-medium">{roleLabel(a.role)}</span>
                        <span className="text-ink-3"> needs your input</span>
                      </p>
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
