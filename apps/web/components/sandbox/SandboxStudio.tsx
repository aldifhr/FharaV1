"use client";

/**
 * Agent Sandbox (frontend only): run experiments isolated from production.
 * An experiment is a real task created through `tasks.createFromCommand`,
 * prefixed `[Sandbox]`, forced to supervised permission mode, with the
 * isolation instruction first. The toolbar shows exactly what will be
 * dispatched before it runs.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { FlaskConical, Play, ShieldCheck } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "../Toasts";
import { relativeTime } from "@/lib/runFormat";
import {
  SANDBOX_PREFIX,
  defaultSandboxConfig,
  sandboxCommand,
  sandboxModeSummary,
  validateSandbox,
  type SandboxConfig,
} from "@/lib/sandbox";
import {
  PERMISSION_MODES,
  PERMISSION_MODE_HINTS,
  PERMISSION_MODE_LABELS,
} from "@/api/convex/lib/permissionModes";

const INPUT =
  "w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-3 focus:border-line-strong";
const LABEL = "grid gap-1.5 text-[12.5px] text-ink-2";
const GHOST_BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover disabled:opacity-50";
const PRIMARY_BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-ink px-3 py-2 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-50";

type TaskRow = {
  _id: string;
  title: string;
  status: string;
  createdAt?: number;
  startedAt?: number;
  requirementCoverage?: { outcome?: string } | null;
};

function coverageNote(outcome: string | undefined): string | null {
  if (outcome === "gaps") return "coverage gaps";
  if (outcome === "completed_with_gaps") return "done with gaps";
  return null;
}

export default function SandboxStudio() {
  const toast = useToast();
  const router = useRouter();
  const projects = useQuery(api.projects.list, {}) as Array<{ _id: string; name: string }> | undefined;
  const createTask = useMutation(api.tasks.createFromCommand);
  const [config, setConfig] = useState<SandboxConfig>(() => defaultSandboxConfig());
  const [running, setRunning] = useState(false);

  const projectId = config.projectId || projects?.[0]?._id || "";
  const tasks = useQuery(
    api.tasks.listByProject,
    projectId ? { projectId: projectId as never, limit: 50 } : "skip",
  ) as TaskRow[] | undefined;
  const history = useMemo(
    () => (tasks ?? []).filter((task) => task.title.startsWith(SANDBOX_PREFIX)).slice(0, 10),
    [tasks],
  );

  const projectsLoading = projects === undefined;
  const projectsEmpty = projects !== undefined && projects.length === 0;
  const validation = useMemo(() => validateSandbox({ ...config, projectId }), [config, projectId]);
  const issues = projectsLoading ? [] : validation;
  const preview = useMemo(() => sandboxCommand({ ...config, projectId }), [config, projectId]);

  const run = async () => {
    if (validation.length > 0) {
      toast("error", "Cannot run yet", validation[0]);
      return;
    }
    setRunning(true);
    try {
      const taskId = await createTask({
        projectId: projectId as never,
        command: preview,
        title: `${SANDBOX_PREFIX} ${config.name.trim()}`,
        permissionMode: config.permissionMode,
      });
      toast("success", "Sandbox experiment queued", config.name);
      setConfig((current) => ({ ...current, instruction: "", name: "" }));
      router.push(`/runs/${String(taskId)}`);
    } catch (err) {
      toast("error", "Couldn't queue", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setRunning(false);
    }
  };

  const patch = (next: Partial<SandboxConfig>) => setConfig((current) => ({ ...current, ...next }));

  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-canvas px-6 py-8 max-[979px]:px-4">
      <div className="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[1fr_380px]">
        <div className="min-w-0">
          <header>
            <h1 className="flex items-center gap-2 text-[26px] font-semibold tracking-tight ">
              <FlaskConical size={24} /> Agent Sandbox
            </h1>
            <p className="mt-1 max-w-2xl text-[14px] text-ink-2">
              Run agent experiments isolated from production: a task in the project worktree, prefixed with `[Sandbox]`,
              with explicit guardrails. You pick how much it may do on its own; nothing is pushed or merged without your
              approval.
            </p>
          </header>

          <div className="mt-6 grid gap-4">
            <label className={LABEL}>
              Experiment name
              <input
                value={config.name}
                onChange={(event) => patch({ name: event.target.value })}
                placeholder="e.g. Try the new auth flow"
                className={INPUT}
                aria-label="Experiment name"
              />
            </label>
            <label className={LABEL}>
              Project
              <select
                value={projectId}
                onChange={(event) => patch({ projectId: event.target.value })}
                className={INPUT}
                aria-label="Project"
                disabled={projectsLoading || projectsEmpty}
              >
                {projectsLoading && <option value="">Loading projects…</option>}
                {projectsEmpty && <option value="">No projects yet</option>}
                {projects?.map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {projectsEmpty && (
                <span className="text-[12px] text-ink-3">Create a project first — sandbox experiments are real tasks in a project.</span>
              )}
            </label>
            <label className={LABEL}>
              Instruction
              <textarea
                value={config.instruction}
                onChange={(event) => patch({ instruction: event.target.value })}
                rows={4}
                placeholder="What should the sandbox try? Be specific — this becomes the task command."
                className={INPUT}
                aria-label="Experiment instruction"
              />
            </label>
            <label className={LABEL}>
              Approval mode
              <select
                value={config.permissionMode}
                onChange={(event) => patch({ permissionMode: event.target.value as SandboxConfig["permissionMode"] })}
                className={INPUT}
                aria-label="Approval mode"
              >
                {PERMISSION_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {PERMISSION_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
              <span className="text-[12px] text-ink-3">{PERMISSION_MODE_HINTS[config.permissionMode]}.</span>
            </label>
            <div className={LABEL} role="group" aria-label="Guardrails">
              <span>
                Guardrails{" "}
                <span className="font-normal text-ink-3">— written into the brief; the real gate is the approval mode above</span>
              </span>
                <label className="flex items-start gap-2 rounded-lg border border-line px-2.5 py-2 text-[13px] text-ink-2">
                  <input
                    type="checkbox"
                    checked={config.guardProduction}
                    onChange={(event) => patch({ guardProduction: event.target.checked })}
                    className="mt-0.5 h-4 w-4 accent-current"
                  />
                  <span>
                    <span className="font-medium text-ink">Do not touch production</span>
                    <span className="block text-[12px] text-ink-3">No production paths, secrets or settings</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 rounded-lg border border-line px-2.5 py-2 text-[13px] text-ink-2">
                  <input
                    type="checkbox"
                    checked={config.guardPush}
                    onChange={(event) => patch({ guardPush: event.target.checked })}
                    className="mt-0.5 h-4 w-4 accent-current"
                  />
                  <span>
                    <span className="font-medium text-ink">Never push</span>
                    <span className="block text-[12px] text-ink-3">Nothing leaves the worktree without approval</span>
                  </span>
                </label>
                <label className="grid gap-1 text-[13px] text-ink-2 sm:max-w-60">
                  Time box (minutes, advisory)
                  <input
                    type="number"
                    min={5}
                    max={240}
                    value={config.timeboxMinutes}
                    onChange={(event) => patch({ timeboxMinutes: Math.max(5, Math.min(240, Number(event.target.value) || 30)) })}
                    className={INPUT}
                    aria-label="Time box in minutes"
                  />
                </label>
            </div>
            {issues.length > 0 && (
              <p className="text-[13px] text-amber-700 dark:text-amber-400">{issues.join(" ")}</p>
            )}
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void run()} disabled={running || validation.length > 0} className={PRIMARY_BTN}>
                <Play size={14} /> {running ? "Queueing…" : "Run in sandbox"}
              </button>
              <span className="text-[12px] text-ink-3">
                Creates a real task titled `[Sandbox] …` in {PERMISSION_MODE_LABELS[config.permissionMode]} mode.
              </span>
            </div>
          </div>

          {history.length > 0 && (
            <section className="mt-8">
              <h2 className="text-[15px] font-semibold">Recent sandbox runs</h2>
              <ul className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
                  {history.map((task) => {
                    const note = coverageNote(task.requirementCoverage?.outcome);
                    return (
                      <li key={task._id}>
                        <Link href={`/runs/${task._id}`} className="flex items-center gap-3 px-4 py-2.5 transition hover:bg-hover">
                          <span className="min-w-0 flex-1 truncate text-[13px]">{task.title}</span>
                          {note && (
                            <span className="shrink-0 rounded-full border border-amber-500/40 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                              {note}
                            </span>
                          )}
                          <span className="shrink-0 text-[12px] text-ink-3">{task.status}</span>
                          <span className="shrink-0 text-[12px] tabular-nums text-ink-3">{relativeTime(task.createdAt ?? task.startedAt ?? Date.now())}</span>
                        </Link>
                      </li>
                    );
                  })}
              </ul>
            </section>
          )}
        </div>

        <aside className="h-fit rounded-xl border border-line bg-panel p-4 lg:sticky lg:top-6" aria-label="Sandbox preview">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <ShieldCheck size={14} /> What runs
          </p>
          <ul className="mt-2 grid gap-1.5 text-[12.5px] text-ink-2">
            <li>• {sandboxModeSummary(config.permissionMode)}</li>
            <li>• Worktree-scoped — nothing lands on the main branch silently.</li>
            <li>• Push / PR always ask.</li>
            <li>• The task is visible under Runs — this page opens it after queuing.</li>
          </ul>
          <p className="mt-3 text-[12px] font-semibold text-ink-2">Dispatched command</p>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[11.5px] text-ink-2">
            {preview}
          </pre>
          <p className="mt-3 text-[11.5px] text-ink-3">
            Honest limits: no separate production database or network namespace — isolation here is the approval mode, worktree
            scoping, and the no-push guardrail. Use separate projects for fully separate data.
          </p>
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(preview).then(() => toast("success", "Copied")).catch(() => toast("error", "Copy failed"))}
            className={`${GHOST_BTN} mt-3 w-full justify-center`}
          >
            Copy command
          </button>
        </aside>
      </div>
    </main>
  );
}
