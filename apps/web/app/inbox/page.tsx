"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import Link from "next/link";
import IconRail from "@/components/IconRail";
import { roleLabel } from "@/lib/agentRoles";
import AgentAvatar from "@/components/AgentAvatar";
import { BlurFade } from "@/components/ui/blur-fade";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { Skeleton, SkeletonBox } from "skullet/react";

const KIND_LABEL: Record<string, string> = {
  apply_changes: "Apply changes",
  git_push: "Git push",
  run_command: "Run command",
};

function InboxSkeleton() {
  return (
    <div aria-hidden className="pointer-events-none">
      <SkeletonBox height={28} width={80} radius={8} />
      <SkeletonBox height={14} width={220} className="mt-3" />

      {["Needs approval", "Tasks", "Agents"].map((heading, i) => (
        <div key={heading} className="mt-6">
          <SkeletonBox height={12} width={100 + i * 16} />
          <div className="mt-2 grid gap-2">
            {Array.from({ length: i === 0 ? 2 : 1 }).map((_, j) => (
              <div key={j} className="rounded-xl border border-[#ebe9f0] bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
                <div className="flex items-start justify-between gap-3">
                  <div className="w-full">
                    <SkeletonBox height={14} width={i === 0 ? "60%" : "45%"} />
                    <SkeletonBox height={12} width="40%" className="mt-2" />
                    <SkeletonBox height={18} width={100} radius={999} className="mt-3" />
                  </div>
                  <SkeletonBox height={28} width={56} radius={8} />
                </div>
                {i === 0 && (
                  <div className="mt-3 flex gap-2">
                    <SkeletonBox height={30} width={80} radius={8} />
                    <SkeletonBox height={30} width={70} radius={8} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function InboxPage() {
  const inbox = useQuery(api.inbox.list, {});
  const approve = useMutation(api.approvals.approve);
  const reject = useMutation(api.approvals.reject);

  if (inbox === undefined) {
    return (
      <div className="flex h-screen overflow-hidden bg-transparent text-gray-900 dark:text-gray-100 max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
        <IconRail />
        <main className="min-w-0 flex-1 overflow-y-auto p-6 max-[979px]:p-4">
          <div className="mx-auto max-w-2xl">
            <Skeleton loading skeleton={<InboxSkeleton />} label="Loading inbox">
              {null}
            </Skeleton>
          </div>
        </main>
      </div>
    );
  }

  const total = inbox.approvals.length + inbox.tasks.length + inbox.agents.length;

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-gray-900 dark:text-gray-100 max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail />
      <main className="min-w-0 flex-1 overflow-y-auto p-6 max-[979px]:p-4">
        <div className="mx-auto max-w-2xl">
            <h1 className="text-xl font-semibold">Inbox</h1>
            <p className="mt-1 text-sm text-gray-500">
              {total ? `${total} item(s) need your attention across projects.` : "Nothing is waiting for you."}
            </p>

            {inbox.approvals.length > 0 && (
              <section className="mt-6">
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  Needs approval ({inbox.approvals.length})
                </h2>
                <div className="mt-2 grid gap-2">
                  {inbox.approvals.map((a, i) => (
                    <BlurFade key={a._id} delay={i * 0.05} inView>
                      <div className="rounded-xl border border-[#ebe9f0] bg-white p-4 shadow-[0_1px_2px_rgba(30,25,60,.03)] dark:border-gray-800 dark:bg-gray-900">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium">{a.summary}</p>
                            <p className="mt-1 text-xs text-gray-500">
                              {a.projectName}
                              {a.taskTitle ? ` · ${a.taskTitle}` : ""}
                              {a.requestedByAgentName ? ` · requested by ${roleLabel(a.requestedByAgentName)}` : ""}
                            </p>
                            <span className="mt-2 inline-block rounded-full bg-[#eeecfb] px-2 py-0.5 text-[11px] font-semibold text-[#4c42a3] dark:bg-gray-800">
                              {KIND_LABEL[a.kind] ?? a.kind}
                            </span>
                          </div>
                          <Link
                            href={`/chats/${a.projectId}`}
                            className="shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                          >
                            Open project
                          </Link>
                        </div>
                        <div className="mt-3 flex gap-2">
                          <ShimmerButton
                            shimmerDuration="2.5s"
                            onClick={() => approve({ approvalId: a._id })}
                            className="rounded-lg px-3 py-1.5 text-sm font-semibold"
                          >
                            Approve
                          </ShimmerButton>
                          <button
                            onClick={() => reject({ approvalId: a._id })}
                            className="rounded-lg bg-gray-200 px-3 py-1.5 text-sm font-semibold dark:bg-gray-800 dark:text-white"
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    </BlurFade>
                  ))}
                </div>
              </section>
            )}

            {inbox.tasks.length > 0 && (
              <section className="mt-6">
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  Task needs attention ({inbox.tasks.length})
                </h2>
                <div className="mt-2 grid gap-2">
                  {inbox.tasks.map((t) => (
                    <Link
                      key={t._id}
                      href={`/chats/${t.projectId}`}
                      className="rounded-xl border border-[#ebe9f0] bg-white p-4 hover:bg-[#fbfbfd] dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-gray-900"
                    >
                      <p className="font-medium">{t.title}</p>
                      <p className="mt-1 text-xs text-gray-500">{t.projectName}</p>
                      <span
                        className={`mt-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          t.status === "failed" ? "bg-red-50 text-red-600 dark:bg-red-950" : "bg-amber-50 text-amber-600 dark:bg-amber-950"
                        }`}
                      >
                        {t.status === "failed" ? "Failed" : "Pending approval"}
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {inbox.agents.length > 0 && (
              <section className="mt-6">
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  Agents waiting for you ({inbox.agents.length})
                </h2>
                <div className="mt-2 grid gap-2">
                  {inbox.agents.map((a) => (
                    <div key={a._id} className="flex items-center gap-3 rounded-xl border border-[#ebe9f0] bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
                      <AgentAvatar name={roleLabel(a.role)} size={32} status={a.status} avatarParams={a.avatarParams} />
                      <div className="min-w-0">
                        <p className="font-medium">{roleLabel(a.role)}</p>
                        <p className="text-xs text-gray-500">needs_you</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {total === 0 && (
              <div className="mt-10 rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-400 dark:border-gray-700">
                Inbox is empty. All approvals have been processed.
              </div>
            )}
        </div>
      </main>
    </div>
  );
}
