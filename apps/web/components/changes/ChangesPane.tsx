"use client";
// Paradev A2 (plan audit/paradev-plan-2026-11-11.md, P-A): the read-only
// Changes pane of one task. Proposed files (fileChanges) before Accept, the
// committed branch (changes.branchPatch) after; Open PR goes through the
// existing git_push approval path (githubPush.requestPush), never a direct
// push. Idea from Paradev's DiffPane; markup and data flow are Fhara's.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import type { BranchPatchResult } from "@/api/convex/changes";
import DiffCard from "../DiffCard";
import { useToast } from "../Toasts";
import ChangesFileList from "./ChangesFileList";
import ChangesHeader, { type HeaderActing } from "./ChangesHeader";
import ChecksList from "./ChecksList";
import DraftCommentsBar from "./DraftCommentsBar";
import { useLineComments } from "./useLineComments";
import { OPEN_CHANGES_EVENT, consumeOpenChanges, diffChangeType, isPatchTruncated, splitPatchByFile, stepFile } from "@/lib/changesView";
import { matchesChord, useKeybindings } from "@/lib/keybindings";

/** Diffs past this many start collapsed so a big change set stays scannable. */
const EXPANDED_FILES = 3;

const errorText = (err: unknown) => (err instanceof Error ? err.message : "Please try again.");

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

export type ThreadView = "thread" | "changes";

/**
 * The task thread's tab. Opens on Changes when a card asked for it
 * ("Open changes"), follows later requests, and toggles on Mod+Shift+G.
 */
export function useThreadView(taskId: string | null): [ThreadView, (view: ThreadView) => void] {
  const [view, setView] = useState<ThreadView>(() => (consumeOpenChanges(taskId) ? "changes" : "thread"));
  const bindings = useKeybindings();
  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<{ taskId: string }>).detail?.taskId !== taskId) return;
      consumeOpenChanges(taskId);
      setView("changes");
    };
    const onKey = (e: KeyboardEvent) => {
      if (!matchesChord(e, bindings.toggleChanges)) return;
      e.preventDefault();
      setView((v) => (v === "changes" ? "thread" : "changes"));
    };
    window.addEventListener(OPEN_CHANGES_EVENT, onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_CHANGES_EVENT, onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, [taskId, bindings.toggleChanges]);
  return [view, setView];
}

export default function ChangesPane({ taskId }: { taskId: string }) {
  const toast = useToast();
  const bindings = useKeybindings();
  const view = useQuery(api.changes.forTask, { taskId: taskId as any });
  const proposedRows = useQuery(api.fileChanges.listByTask, view?.source === "proposed" ? { taskId: taskId as any } : "skip");
  const loadPatch = useAction(api.changes.branchPatch);
  const requestPush = useMutation(api.githubPush.requestPush);
  const refreshPr = useAction(api.githubPush.refreshPrStatus);
  const [patch, setPatch] = useState<BranchPatchResult | null | "loading" | "error">(null);
  const [acting, setActing] = useState<HeaderActing>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const comments = useLineComments(taskId, view);

  // The branch patch is read once per commit (a fix round's commit reloads it).
  const commitSha = view?.source === "branch" ? view.commit?.sha : undefined;
  useEffect(() => {
    if (!commitSha) {
      setPatch(null);
      return;
    }
    let live = true;
    setPatch("loading");
    loadPatch({ taskId: taskId as any })
      .then((res) => live && setPatch(res))
      .catch(() => live && setPatch("error"));
    return () => {
      live = false;
    };
  }, [commitSha, taskId, loadPatch]);

  const okPatch = patch && typeof patch === "object" && patch.status === "ok" ? patch : null;
  // After commit the exact list comes with the branch patch, not the proposed rows.
  const files = okPatch ? okPatch.files : view?.source === "branch" ? [] : (view?.files ?? []);
  const diffs = useMemo(() => {
    if (okPatch) return splitPatchByFile(okPatch.patch, okPatch.files);
    const map = new Map<string, string>();
    const newest = new Map<string, any>();
    for (const row of proposedRows ?? []) {
      const prior = newest.get(row.filePath);
      if (!prior || (prior._creationTime ?? 0) <= (row._creationTime ?? 0)) newest.set(row.filePath, row);
    }
    for (const [path, row] of newest) map.set(path, row.diff ?? "");
    return map;
  }, [okPatch, proposedRows]);
  const truncated = Boolean(okPatch && (okPatch.truncated || isPatchTruncated(okPatch.patch)));

  const select = useCallback((path: string) => {
    setSelected(path);
    setOpen((prev) => ({ ...prev, [path]: true }));
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector(`[data-diff-path="${CSS.escape(path)}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const delta = matchesChord(e, bindings.nextFile) ? 1 : matchesChord(e, bindings.prevFile) ? -1 : 0;
      if (!delta || files.length === 0) return;
      e.preventDefault();
      const at = stepFile(files.findIndex((f) => f.path === selected), files.length, delta);
      if (at >= 0) select(files[at].path);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bindings.nextFile, bindings.prevFile, files, selected, select]);

  const run = async (what: NonNullable<HeaderActing>, fn: () => Promise<unknown>, failure: string) => {
    setActing(what);
    try {
      await fn();
      if (what === "pr") toast("success", "Push requested", "The PR opens once the branch is pushed.");
    } catch (err) {
      toast("error", failure, errorText(err));
    } finally {
      setActing(null);
    }
  };
  const pushId = view?.pushId;
  const openPr = () => pushId && void run("pr", () => requestPush({ pushId, openPr: true }), "Couldn't open the PR");
  const refresh = () => pushId && void run("refresh", () => refreshPr({ pushId }), "Couldn't refresh the PR status");

  if (view === undefined) return <p className="p-5 text-[13px] text-ink-3" role="status">Loading changes…</p>;
  if (view === null) return <p className="p-5 text-[13px] text-ink-3">This task's changes are not available.</p>;

  const patchNote =
    patch === "loading"
      ? "Loading diff…"
      : patch === "error"
        ? "Couldn't read the branch diff."
        : patch && typeof patch === "object" && patch.status === "worktree-gone"
          ? "The worktree was removed, so the branch diff can't be read."
          : null;

  return (
    <div ref={listRef} className="shell-scroll h-0 min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pb-6" data-testid="changes-pane">
      <ChangesHeader view={view} acting={acting} onOpenPr={openPr} onRefresh={refresh} />
      {view.pr && <ChecksList checks={view.pr.ciChecks} onRefresh={pushId && view.flow.kind !== "pr-exists" ? refresh : undefined} refreshing={acting === "refresh"} />}
      {files.length === 0 ? (
        !patchNote && <p className="px-4 text-[13px] text-ink-3">No file changes yet.</p>
      ) : (
        <section aria-label="Files" className="space-y-1.5">
          <h3 className="px-4 text-[13px] font-semibold text-ink">
            {files.length} {files.length === 1 ? "file" : "files"} changed
          </h3>
          <ChangesFileList files={files} selectedPath={selected} onSelect={select} />
        </section>
      )}
      {patchNote && <p className="px-4 text-[13px] text-ink-3">{patchNote}</p>}
      {truncated && (
        <p className="px-4 text-[13px] text-ink-2" data-testid="changes-truncated">
          Diff truncated: later files are listed but not shown.
        </p>
      )}
      {files.length > 0 && !patchNote && (
        <div className="border-b border-line">
          {files.map((file, index) => {
            const diff = diffs.get(file.path);
            return (
              <div key={file.path} data-diff-path={file.path} className="scroll-mt-2">
                {diff === undefined ? (
                  <p className="flex items-center gap-2 border-t border-line px-4 py-2 text-[12.5px]">
                    <span className="min-w-0 flex-1 truncate font-mono text-ink-2">{file.path}</span>
                    <span className="shrink-0 text-ink-3">
                      {file.isBinary ? "Binary file" : truncated ? "Not shown (diff truncated)" : proposedRows === undefined && view.source === "proposed" ? "Loading…" : "No diff"}
                    </span>
                  </p>
                ) : (
                  <DiffCard
                    variant="flush"
                    forceUnified
                    filePath={file.path}
                    diff={diff}
                    changeType={diffChangeType(file.status)}
                    expanded={open[file.path] ?? index < EXPANDED_FILES}
                    onExpandedChange={(value) => setOpen((prev) => ({ ...prev, [file.path]: value }))}
                    {...comments.fileProps(file.path, file.oldPath, diff)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      <DraftCommentsBar
        draftCount={comments.draftCount}
        sending={comments.sending}
        lastRound={comments.lastRound}
        refusal={comments.refusal}
        error={comments.sendError}
        onSend={() => void comments.send()}
      />
    </div>
  );
}
