"use client";

import { useQuery } from "convex/react";
import { api } from "../../../api/convex/_generated/api";
import IconRail from "../../components/IconRail";
import { BlurFade } from "@/components/ui/blur-fade";
import { Liveline } from "liveline";
import type { LivelinePoint } from "liveline";
import { TextMorph } from "torph/react";
import { SkeletonBox } from "skullet/react";

function AnalyticsSkeleton() {
  return (
    <div aria-hidden className="pointer-events-none">
      <div className="flex items-center gap-2">
        <SkeletonBox height={24} width={110} radius={8} />
        <SkeletonBox height={16} width={16} radius={999} />
      </div>
      <SkeletonBox height={14} width={264} className="mt-3" />

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-[#ebe9f0] bg-white/70 p-5 dark:border-gray-800 dark:bg-gray-900/60">
            <SkeletonBox height={13} width={72} />
            <SkeletonBox height={34} width={64} className="mt-2" />
          </div>
        ))}
      </div>

      <div className="mt-6">
        <SkeletonBox height={13} width={96} />
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-[#ebe9f0] bg-white/70 p-4 dark:border-gray-800 dark:bg-gray-900/60">
              <SkeletonBox height={13} width={80} />
              <SkeletonBox height={28} width={72} className="mt-2" />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6">
        <SkeletonBox height={13} width={88} />
        <div className="mt-2 rounded-xl border border-[#ebe9f0] bg-white/70 p-4 dark:border-gray-800 dark:bg-gray-900/60">
          <SkeletonBox height={192} width="100%" radius={0} />
        </div>
      </div>

      <div className="mt-6">
        <SkeletonBox height={13} width={104} />
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-[#ebe9f0] bg-white/70 p-4 dark:border-gray-800 dark:bg-gray-900/60">
              <SkeletonBox height={14} width="45%" />
              <SkeletonBox height={28} width={64} className="mt-2" />
              <SkeletonBox height={12} width="70%" className="mt-2" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const projects = useQuery(api.projects.list, {});
  const overview = useQuery(api.overview.get, {});
  const agents = useQuery(api.agents.list, {});
  const tokenUsage = useQuery(api.orchestration.tokenUsageStats, {});

  const totalProjects = projects?.length ?? 0;
  const totalTasks = overview?.taskCounts?.total ?? 0;
  const totalAgents = agents?.length ?? 0;

  const tokensTotal = (tokenUsage?.totalInput ?? 0) + (tokenUsage?.totalOutput ?? 0);

  const tasksByStatus = overview?.taskCounts?.byStatus ?? {};

  const agentsByRole = (agents ?? []).reduce(
    (acc, a) => {
      acc[a.role] = (acc[a.role] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  if (projects === undefined || overview === undefined || agents === undefined || tokenUsage === undefined) {
    return (
      <div className="flex h-screen overflow-hidden bg-transparent text-gray-900 dark:text-gray-100 max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
        <IconRail />
        <main className="min-w-0 flex-1 overflow-y-auto p-6 max-[979px]:p-4">
          <div className="mx-auto max-w-3xl">
            <AnalyticsSkeleton />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-gray-900 dark:text-gray-100 max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail />
      <main className="min-w-0 flex-1 overflow-y-auto p-6 max-[979px]:p-4">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">Analytics</h1>
            <span className="relative flex h-2 w-2" title="Live data">
              <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
          </div>
          <p className="mt-1 text-sm text-gray-500">Overview of projects, tasks, and agents.</p>

          <section className="mt-6 grid gap-4 sm:grid-cols-3">
            <BlurFade inView>
              <div className="rounded-xl border border-[#ebe9f0] bg-white/70 p-5 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
                <p className="text-sm font-medium text-gray-500">Projects</p>
                <p className="mt-1 text-3xl font-bold"><TextMorph>{totalProjects}</TextMorph></p>
              </div>
            </BlurFade>
            <BlurFade inView delay={0.05}>
              <div className="rounded-xl border border-[#ebe9f0] bg-white/70 p-5 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
                <p className="text-sm font-medium text-gray-500">Tasks</p>
                <p className="mt-1 text-3xl font-bold"><TextMorph>{totalTasks}</TextMorph></p>
              </div>
            </BlurFade>
            <BlurFade inView delay={0.1}>
              <div className="rounded-xl border border-[#ebe9f0] bg-white/70 p-5 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
                <p className="text-sm font-medium text-gray-500">Agents</p>
                <p className="mt-1 text-3xl font-bold"><TextMorph>{totalAgents}</TextMorph></p>
              </div>
            </BlurFade>
          </section>

          <section className="mt-6">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Token overview</h2>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <BlurFade inView>
                <div className="rounded-xl border border-[#ebe9f0] bg-white/70 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
                  <p className="text-sm font-medium text-gray-500">Input tokens</p>
                  <p className="mt-1 text-2xl font-bold"><TextMorph>{tokenUsage?.totalInput ?? 0}</TextMorph></p>
                </div>
              </BlurFade>
              <BlurFade inView delay={0.05}>
                <div className="rounded-xl border border-[#ebe9f0] bg-white/70 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
                  <p className="text-sm font-medium text-gray-500">Output tokens</p>
                  <p className="mt-1 text-2xl font-bold"><TextMorph>{tokenUsage?.totalOutput ?? 0}</TextMorph></p>
                </div>
              </BlurFade>
              <BlurFade inView delay={0.1}>
                <div className="rounded-xl border border-[#ebe9f0] bg-white/70 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
                  <p className="text-sm font-medium text-gray-500">Total tokens</p>
                  <p className="mt-1 text-2xl font-bold"><TextMorph>{tokensTotal}</TextMorph></p>
                  <p className="mt-0.5 text-[11px] text-gray-400">{tokenUsage?.totalCalls ?? 0} LLM call(s)</p>
                </div>
              </BlurFade>
            </div>
          </section>

          <section className="mt-6">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Token usage</h2>
            <div className="mt-2 rounded-xl border border-[#ebe9f0] bg-white/70 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
              <div className="h-48">
                {(() => {
                  const timeline = (tokenUsage?.timeline ?? []) as LivelinePoint[];
                  const last = timeline[timeline.length - 1]?.value ?? 0;
                  const range = timeline.length > 1 ? timeline[timeline.length - 1].time - timeline[0].time : 0;
                  return (
                    <Liveline
                      data={timeline}
                      value={last}
                      color="#6252d8"
                      theme="light"
                      window={range > 0 ? range + 60 : 86400}
                      exaggerate
                      formatValue={(v) => v.toLocaleString()}
                      formatTime={(t) => new Date(t * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                      loading={tokenUsage === undefined}
                    />
                  );
                })()}
              </div>
            </div>
          </section>

          <section className="mt-6">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Tokens by agent</h2>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {tokenUsage && Object.keys(tokenUsage.byAgent).length === 0 && (
                <p className="text-sm text-gray-400">No token usage recorded yet.</p>
              )}
              {tokenUsage && Object.entries(tokenUsage.byAgent).map(([name, stats]) => (
                <BlurFade key={name} inView>
                  <div className="rounded-xl border border-[#ebe9f0] bg-white/70 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
                    <p className="text-sm font-medium">{name}</p>
                    <p className="mt-1 text-2xl font-bold"><TextMorph>{stats.inputTokens + stats.outputTokens}</TextMorph></p>
                    <p className="mt-0.5 text-[11px] text-gray-400">
                      {stats.calls} call(s) · in {stats.inputTokens.toLocaleString()} / out {stats.outputTokens.toLocaleString()}
                    </p>
                  </div>
                </BlurFade>
              ))}
            </div>
          </section>

          <section className="mt-6">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Tasks by status</h2>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {Object.entries(tasksByStatus).length === 0 && (
                <p className="text-sm text-gray-400">No tasks yet.</p>
              )}
              {Object.entries(tasksByStatus).map(([status, count]) => (
                <BlurFade key={status} inView>
                  <div className="rounded-xl border border-[#ebe9f0] bg-white/70 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
                    <p className="text-sm font-medium capitalize">{status}</p>
                    <p className="mt-1 text-2xl font-bold">{count}</p>
                  </div>
                </BlurFade>
              ))}
            </div>
          </section>

          <section className="mt-6">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Agents by role</h2>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {Object.entries(agentsByRole).length === 0 && (
                <p className="text-sm text-gray-400">No agents yet.</p>
              )}
              {Object.entries(agentsByRole).map(([role, count]) => (
                <BlurFade key={role} inView>
                  <div className="rounded-xl border border-[#ebe9f0] bg-white/70 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
                    <p className="text-sm font-medium capitalize">{role}</p>
                    <p className="mt-1 text-2xl font-bold">{count}</p>
                  </div>
                </BlurFade>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
