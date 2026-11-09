"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { ArrowUp, Check, ExternalLink, GitPullRequest, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import type { PushCardData } from "@/api/convex/cardTypes";
import { useToast } from "../../Toasts";
import { useCardSurface } from "./CardContext";
import {
  BTN_OUTLINE,
  BTN_PRIMARY,
  BTN_TEXT,
  CARD_DIVIDER,
  CardHeader,
  CardShell,
  IconTile,
  MUTED,
  Pill,
  type PillTone,
  StatusWord,
  type StepStatus,
} from "./primitives";

type View = NonNullable<ReturnType<typeof useQuery<typeof api.githubPush.get>>>;

const errorText = (err: unknown) => (err instanceof Error ? err.message.replace(/^.*Uncaught Error: /s, "").split("\n")[0] : "Please try again.");

function stepFrom(checks: Array<{ name: string; status: string; counts?: { passed: number; total: number } }>, name: string) {
  const matching = checks.filter((check) => check.name === name);
  if (matching.length === 0) return { status: "not_run" as StepStatus };
  if (matching.some((check) => check.status === "failed")) return { status: "failed" as StepStatus };
  if (matching.every((check) => check.status === "passed")) {
    const counts = matching.find((check) => check.counts)?.counts;
    return { status: "passed" as StepStatus, label: counts ? `${counts.passed} of ${counts.total}` : undefined };
  }
  return { status: "not_run" as StepStatus };
}

function qaPhones(view: View): { status: StepStatus; label?: string; settled: boolean } {
  const qa = view.qa;
  if (!qa) return { status: "not_run", settled: true };
  const phone = (qa.rows ?? []).find((row: any) => row.width === 375);
  const status: StepStatus = phone
    ? phone.status === "passed"
      ? "passed"
      : phone.status === "failed"
        ? "failed"
        : phone.status === "running"
          ? "running"
          : phone.status === "pending"
            ? "pending"
            : "not_run"
    : qa.outcome === "passed"
      ? "passed"
      : qa.outcome === "failed"
        ? "failed"
        : qa.outcome === "running"
          ? "running"
          : "blocked";
  return {
    status,
    label: status === "blocked" ? "Skipped" : undefined,
    // Blocked QA (environment) never holds the push back.
    settled: qa.outcome !== "running",
  };
}

function headerPill(view: View): { tone: PillTone; label: string } {
  switch (view.status) {
    case "ready":
      return view.heldAt ? { tone: "gray", label: "Held" } : { tone: "orange", label: "Needs you" };
    case "requested":
      return { tone: "blue", label: "Queued" };
    case "pushing":
      return { tone: "blue", label: "Pushing" };
    case "failed":
      return { tone: "red", label: "Failed" };
    default:
      if (view.prState === "merged") return { tone: "indigo", label: "Merged" };
      if (view.prState === "closed") return { tone: "red", label: "Closed" };
      if (view.prState === "draft") return { tone: "gray", label: "Draft PR" };
      if (view.prState === "open") return { tone: "green", label: "PR open" };
      return { tone: "green", label: "Pushed" };
  }
}

export default function PushCard({ data }: { data: PushCardData }) {
  const toast = useToast();
  const { onOpenTask } = useCardSurface();
  const view = useQuery(api.githubPush.get, data.pushId ? { pushId: data.pushId as any } : "skip");
  const requestPush = useMutation(api.githubPush.requestPush);
  const holdPush = useMutation(api.githubPush.holdPush);
  const refreshPr = useAction(api.githubPush.refreshPrStatus);
  const [openPr, setOpenPr] = useState(true);
  const [acting, setActing] = useState<null | "approve" | "hold" | "refresh" | "pr">(null);

  if (view === undefined) {
    return (
      <CardShell>
        <div className={`flex items-center gap-2 px-4 py-4 text-[13px] ${MUTED}`}>
          <Loader2 size={14} className="animate-spin" /> Loading push…
        </div>
      </CardShell>
    );
  }
  if (view === null) {
    return (
      <CardShell>
        <p className={`px-4 py-3 text-[13px] ${MUTED}`}>This push is no longer available.</p>
      </CardShell>
    );
  }

  const run = async (what: NonNullable<typeof acting>, fn: () => Promise<unknown>, failure: string) => {
    setActing(what);
    try {
      await fn();
    } catch (err) {
      toast("error", failure, errorText(err));
    } finally {
      setActing(null);
    }
  };

  const pill = headerPill(view);
  const verificationChecks = view.verification?.checks ?? [];
  const build = stepFrom(verificationChecks, "build");
  const tests = stepFrom(verificationChecks, "test");
  const phones = qaPhones(view);
  const repo = view.github.repoFullName;
  const canAct = view.status === "ready" || view.status === "failed";
  const blockedReason = !view.github.connected
    ? "Connect GitHub in project settings first"
    : !repo
      ? "Choose a repository in project settings first"
      : !phones.settled
        ? "Waits for QA first"
        : null;
  const subtitle =
    view.status === "pushed"
      ? view.prNumber
        ? `Pushed to ${repo ?? "GitHub"} · PR #${view.prNumber} into ${view.github.baseBranch}`
        : `Pushed to ${repo ?? "GitHub"} · no PR opened`
      : view.status === "pushing"
        ? `Pushing to ${repo ?? "GitHub"}…`
        : view.status === "requested"
          ? "Approved · waiting for the worker to push"
          : view.status === "failed"
            ? view.error ?? "The push failed"
            : repo
              ? `then open a draft PR into ${view.github.baseBranch} on ${repo}`
              : "Nothing leaves this machine until you approve";
  const sha = view.commitSha.slice(0, 7);
  const aheadBehind =
    typeof view.ahead === "number" && typeof view.behind === "number"
      ? `${view.ahead} ahead, ${view.behind} behind ${view.comparedTo ?? "base"}`
      : null;
  const additions = view.additions ?? data.additions;
  const deletions = view.deletions ?? data.deletions;

  const cell = (label: string, content: React.ReactNode) => (
    <div className="min-w-0 px-4 py-3">
      <p className={`text-[12px] ${MUTED}`}>{label}</p>
      <div className="mt-1 truncate text-[15px] font-semibold">{content}</div>
    </div>
  );

  return (
    <CardShell
      header={
        <CardHeader
          icon={
            <IconTile tone={view.status === "failed" ? "red" : view.status === "pushed" ? "green" : "orange"}>
              {view.status === "pushed" ? <Check size={15} /> : <ArrowUp size={15} />}
            </IconTile>
          }
          title={
            <>
              Push to {view.projectName ?? "project"}, branch{" "}
              <span className="font-mono text-[13px]">{view.branchName}</span>
            </>
          }
          subtitle={<span className={view.status === "failed" ? "text-[#c43333] dark:text-rose-300" : undefined}>{subtitle}</span>}
          pill={<Pill tone={pill.tone}>{pill.label}</Pill>}
        />
      }
      actions={
        <>
          {canAct && (
            <>
              <button
                type="button"
                disabled={acting !== null || blockedReason !== null}
                onClick={() =>
                  void run("approve", () => requestPush({ pushId: view._id as any, openPr }), "Couldn't start the push")
                }
                className={BTN_PRIMARY}
                title={blockedReason ?? (openPr ? "Push the branch and open a draft PR" : "Push the branch only")}
              >
                {acting === "approve" ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : view.status === "failed" ? (
                  <RotateCcw size={14} />
                ) : (
                  <Check size={14} />
                )}
                {view.status === "failed" ? "Retry push" : "Approve push"}
              </button>
              {onOpenTask && (
                <button type="button" onClick={() => onOpenTask(String(view.taskId))} className={BTN_OUTLINE}>
                  Review diff
                </button>
              )}
              {view.status === "ready" && !view.heldAt && (
                <button
                  type="button"
                  disabled={acting !== null}
                  onClick={() => void run("hold", () => holdPush({ pushId: view._id as any }), "Couldn't hold the push")}
                  className={BTN_TEXT}
                >
                  Hold
                </button>
              )}
              <label className={`flex cursor-pointer items-center gap-1.5 text-[12px] ${MUTED}`}>
                <input
                  type="checkbox"
                  checked={openPr}
                  onChange={(event) => setOpenPr(event.target.checked)}
                  className="h-3.5 w-3.5 rounded border-[#d5d3dd] accent-[#635bff]"
                />
                Open draft PR
              </label>
              <span className={`ml-auto text-[12px] ${MUTED}`}>
                {blockedReason ?? (view.heldAt ? "Held — approve when ready" : "Waits for your approval")}
              </span>
            </>
          )}
          {(view.status === "requested" || view.status === "pushing") && (
            <span className={`flex items-center gap-1.5 text-[12px] ${MUTED}`}>
              <Loader2 size={13} className="animate-spin" />
              {view.status === "pushing" ? "Pushing…" : "Queued for the worker"}
            </span>
          )}
          {view.status === "pushed" && (
            <>
              {view.prUrl ? (
                <a href={view.prUrl} target="_blank" rel="noreferrer" className={BTN_PRIMARY}>
                  <GitPullRequest size={14} /> PR #{view.prNumber}
                  <ExternalLink size={12} />
                </a>
              ) : (
                <button
                  type="button"
                  disabled={acting !== null || !repo}
                  onClick={() =>
                    void run("pr", () => requestPush({ pushId: view._id as any, openPr: true }), "Couldn't open the PR")
                  }
                  className={BTN_PRIMARY}
                >
                  <GitPullRequest size={14} /> Open draft PR
                </button>
              )}
              {view.prNumber !== undefined && (
                <button
                  type="button"
                  disabled={acting !== null}
                  onClick={() =>
                    void run("refresh", () => refreshPr({ pushId: view._id as any }), "Couldn't refresh the PR status")
                  }
                  className={BTN_TEXT}
                >
                  <RefreshCw size={13} className={acting === "refresh" ? "animate-spin" : ""} /> Refresh status
                </button>
              )}
              {view.prTitle && <span className={`ml-auto min-w-0 truncate text-[12px] ${MUTED}`}>{view.prTitle}</span>}
            </>
          )}
        </>
      }
    >
      <div className={`grid grid-cols-2 border-t sm:grid-cols-4 ${CARD_DIVIDER} [&>*]:border-[#efeef3] dark:[&>*]:border-white/[0.07] [&>*:nth-child(2n)]:border-l sm:[&>*:not(:first-child)]:border-l [&>*:nth-child(n+3)]:border-t sm:[&>*:nth-child(n+3)]:border-t-0`}>
        {cell(
          "Files",
          <span className="tabular-nums">
            <span className="text-[#26242e] dark:text-neutral-100">{view.filesChanged}</span>
            {typeof additions === "number" && <span className="ml-1.5 text-[#1f9d55] dark:text-emerald-400">+{additions}</span>}
            {typeof deletions === "number" && <span className="ml-1.5 text-[#d83a3a] dark:text-rose-400">−{deletions}</span>}
          </span>
        )}
        {cell("Build", <StatusWord status={build.status} label={build.label} />)}
        {cell("Tests", <StatusWord status={tests.status} label={tests.label} />)}
        {cell("QA on phones", <StatusWord status={phones.status} label={phones.label} />)}
      </div>
      <p className={`truncate border-t px-4 py-2 font-mono text-[11px] ${CARD_DIVIDER} ${MUTED}`} title={view.commitMessage}>
        {sha} · {view.commitMessage}
        {aheadBehind ? ` · ${aheadBehind}` : ""}
      </p>
    </CardShell>
  );
}
