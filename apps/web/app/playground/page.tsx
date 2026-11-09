"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import { Play } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import { useToast } from "@/components/Toasts";
import { CopyButton, callRoleLabel } from "@/components/context/ContextInspector";
import { SECTION_KEYS, SECTION_LABELS, estimateTokens, type SectionKey } from "@/api/convex/lib/contextSnapshot";
import { roleLabel } from "@/lib/agentRoles";
import { clockTime } from "@/lib/format";
import { formatCost, formatDuration, formatTokens } from "@/lib/runFormat";

type RunResult = {
  ok: boolean;
  content: string;
  reasoning: string;
  error?: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number | null;
  durationMs: number;
};

const field =
  "w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[13px] text-ink outline-none transition focus:border-ink-3";
const picker = "h-9 rounded-lg border border-line bg-canvas px-2 text-[13px] text-ink outline-none focus:border-ink-3";
const emptySections = (): Record<SectionKey, string> =>
  Object.fromEntries(SECTION_KEYS.map((k) => [k, ""])) as Record<SectionKey, string>;

export default function PlaygroundPage() {
  return (
    <Suspense fallback={null}>
      <Playground />
    </Suspense>
  );
}

function Playground() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const snapshotId = params?.get("snapshot") ?? "";
  const snap = useQuery(api.contextSnapshots.get, snapshotId ? { snapshotId: snapshotId as never } : "skip");
  const recent = useQuery(api.contextSnapshots.recent, { limit: 40 });
  const models = useQuery(api.playground.models, {});
  const projects = useQuery(api.playground.projects, {});
  const run = useAction(api.playgroundNode.run);
  const saveVariant = useMutation(api.playground.saveVariant);

  const [sections, setSections] = useState<Record<SectionKey, string>>(emptySections);
  const [modelKey, setModelKey] = useState("");
  const [temperature, setTemperature] = useState("");
  const [toolsEnabled, setToolsEnabled] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [noteTitle, setNoteTitle] = useState("");

  // Load the snapshot's sections once it arrives (or reset for blank).
  useEffect(() => {
    if (!snapshotId) {
      setSections(emptySections());
      return;
    }
    if (!snap) return;
    const next = emptySections();
    for (const s of snap.sections) if ((SECTION_KEYS as readonly string[]).includes(s.key)) next[s.key as SectionKey] = s.content;
    setSections(next);
    setProjectId(String(snap.projectId));
    setToolsEnabled(snap.toolNames.length > 0);
    if (typeof snap.temperature === "number") setTemperature(String(snap.temperature));
    setResult(null);
  }, [snapshotId, snap]);

  useEffect(() => {
    if (!projectId && projects && projects.length > 0) setProjectId(String(projects[0]._id));
  }, [projects, projectId]);

  // Default model: the snapshot's model when the pool serves it.
  useEffect(() => {
    if (modelKey || !models || models.length === 0) return;
    const match = snap?.model ? models.find((m) => m.modelId === snap.model) : undefined;
    const pick = match ?? models[0];
    setModelKey(`${pick.providerId}|${pick.modelRowId ?? ""}`);
  }, [models, snap, modelKey]);

  const promptTokens = useMemo(
    () => SECTION_KEYS.filter((k) => k !== "tools" || toolsEnabled).reduce((n, k) => n + estimateTokens(sections[k]), 0),
    [sections, toolsEnabled]
  );

  const onRun = async () => {
    if (!projectId) {
      toast("error", "Pick a project", "Usage is recorded against a project.");
      return;
    }
    const [providerId, modelRowId] = modelKey.split("|");
    const temp = temperature.trim() === "" ? undefined : Number(temperature);
    if (temp !== undefined && (!Number.isFinite(temp) || temp < 0 || temp > 2)) {
      toast("error", "Temperature must be between 0 and 2");
      return;
    }
    setRunning(true);
    try {
      const out = await run({
        projectId: projectId as never,
        ...(snapshotId ? { snapshotId: snapshotId as never } : {}),
        sections: SECTION_KEYS.map((key) => ({ key, content: sections[key] })).filter((s) => s.content.trim()),
        ...(providerId ? { providerId: providerId as never } : {}),
        ...(modelRowId ? { modelRowId: modelRowId as never } : {}),
        ...(temp !== undefined ? { temperature: temp } : {}),
        toolsEnabled,
      });
      setResult(out as RunResult);
    } catch (error) {
      toast("error", "Run failed", error instanceof Error ? error.message : undefined);
    } finally {
      setRunning(false);
    }
  };

  const onSave = async () => {
    if (!projectId) return;
    const body = [
      `Model: ${result?.model ?? (models?.find((m) => `${m.providerId}|${m.modelRowId ?? ""}` === modelKey)?.modelId ?? "default")}`,
      `Temperature: ${temperature || "default"} · Tools: ${toolsEnabled ? "on" : "off"}`,
      snapshotId ? `From snapshot: ${snapshotId}` : "",
      ...SECTION_KEYS.filter((k) => sections[k].trim()).map((k) => `## ${SECTION_LABELS[k]}\n${sections[k]}`),
      result ? `## Output\n${result.content || result.error || ""}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      await saveVariant({ projectId: projectId as never, title: noteTitle || "Playground variant", content: body });
      toast("success", "Variant saved", "An unpinned project note in Memory; it is never added to prompts.");
      setNoteTitle("");
    } catch (error) {
      toast("error", "Save failed", error instanceof Error ? error.message : undefined);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail projectId={projectId || undefined} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-6xl">
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Playground</h1>
              <p className="mt-1 text-[13px] text-ink-3">
                Edit a recorded prompt and run it once. Read only: no files, commands or tasks; a tool call in the reply is shown, never run.
              </p>
            </div>
            <label className="flex items-center gap-2 text-[13px] text-ink-2">
              Load
              <select
                className={`${picker} max-w-[24rem]`}
                value={snapshotId}
                onChange={(e) => router.replace(e.target.value ? `/playground?snapshot=${e.target.value}` : "/playground")}
              >
                <option value="">Blank</option>
                {snapshotId && !(recent ?? []).some((r) => r._id === snapshotId) && <option value={snapshotId}>This snapshot</option>}
                {(recent ?? []).map((r) => (
                  <option key={r._id} value={r._id}>
                    {clockTime(r.createdAt)} · {callRoleLabel(r.callRole)}
                    {r.agentRole ? ` · ${roleLabel(r.agentRole)}` : ""}
                    {r.model ? ` · ${r.model}` : ""}
                  </option>
                ))}
              </select>
            </label>
          </header>

          <div className="mt-6 flex flex-wrap items-center gap-3 border-y border-line py-3">
            <select className={picker} value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
              {(projects ?? []).map((p) => (
                <option key={p._id} value={p._id}>{p.name}</option>
              ))}
            </select>
            <select className={`${picker} max-w-[18rem]`} value={modelKey} onChange={(e) => setModelKey(e.target.value)} aria-label="Model">
              {(models ?? []).length === 0 && <option value="">Default (env)</option>}
              {(models ?? []).map((m) => (
                <option key={`${m.providerId}|${m.modelRowId ?? m.modelId}`} value={`${m.providerId}|${m.modelRowId ?? ""}`}>
                  {m.providerName} · {m.label}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-[13px] text-ink-2">
              Temperature
              <input
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                placeholder="default"
                inputMode="decimal"
                className={`${picker} w-20`}
              />
            </label>
            <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
              <input type="checkbox" checked={toolsEnabled} onChange={(e) => setToolsEnabled(e.target.checked)} />
              Tool definitions (prompt text only)
            </label>
            <span className="ml-auto text-[12.5px] tabular-nums text-ink-3">~{formatTokens(promptTokens)} prompt tokens</span>
            <button
              type="button"
              onClick={() => void onRun()}
              disabled={running}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink px-3 text-[13px] font-medium text-canvas disabled:opacity-50"
            >
              <Play size={14} /> {running ? "Running…" : "Run once"}
            </button>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <div>
              <h2 className="mb-2 text-[13px] font-medium text-ink-2">Prompt</h2>
              <ul className="divide-y divide-line">
                {SECTION_KEYS.map((key) => (
                  <li key={key} className="py-3">
                    <div className="mb-1 flex items-baseline justify-between gap-2">
                      <label htmlFor={`sec-${key}`} className={`text-[12.5px] ${key === "tools" && !toolsEnabled ? "text-ink-3" : "text-ink-2"}`}>
                        {SECTION_LABELS[key]}
                        {key === "tools" && !toolsEnabled ? " (off)" : ""}
                      </label>
                      <span className="text-[11.5px] tabular-nums text-ink-3">~{formatTokens(estimateTokens(sections[key]))}</span>
                    </div>
                    <textarea
                      id={`sec-${key}`}
                      value={sections[key]}
                      onChange={(e) => setSections((s) => ({ ...s, [key]: e.target.value }))}
                      rows={key === "user" || key === "system" ? 5 : 3}
                      className={`${field} font-mono text-[12px] leading-relaxed`}
                    />
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-6">
              <div>
                <div className="mb-2 flex items-baseline justify-between">
                  <h2 className="text-[13px] font-medium text-ink-2">Variant output</h2>
                  {result && <CopyButton text={result.content} what="Output" />}
                </div>
                {!result ? (
                  <p className="text-[13px] text-ink-3">{running ? "Waiting for the model…" : "Run once to see the output here."}</p>
                ) : (
                  <>
                    <p className="mb-2 text-[12.5px] tabular-nums text-ink-3">
                      {result.model} · ≈{formatTokens(result.inputTokens)} in / {formatTokens(result.outputTokens)} out · {formatCost(result.estimatedCost)} ·{" "}
                      {formatDuration(result.durationMs)}
                    </p>
                    {result.error ? (
                      <p className="rounded-lg border border-line px-3 py-2 font-mono text-[12px] text-red-600 dark:text-red-400">{result.error}</p>
                    ) : (
                      <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] leading-relaxed text-ink">
                        {result.content || "(empty reply)"}
                      </pre>
                    )}
                  </>
                )}
              </div>

              {snap && (
                <div>
                  <div className="mb-2 flex items-baseline justify-between">
                    <h2 className="text-[13px] font-medium text-ink-2">Original</h2>
                    <CopyButton text={snap.response} what="Original output" />
                  </div>
                  <p className="mb-2 text-[12.5px] tabular-nums text-ink-3">
                    {snap.model ?? "—"} · {snap.usageEstimated ? "≈" : ""}
                    {formatTokens(snap.inputTokens ?? null)} in / {formatTokens(snap.outputTokens ?? null)} out · {formatDuration(snap.durationMs ?? null)}
                  </p>
                  {snap.error && (
                    <p className="mb-2 rounded-lg border border-line px-3 py-2 font-mono text-[12px] text-red-600 dark:text-red-400">{snap.error}</p>
                  )}
                  <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] leading-relaxed text-ink">
                    {snap.response || "(no response)"}
                  </pre>
                </div>
              )}

              <div className="border-t border-line pt-4">
                <h2 className="mb-2 text-[13px] font-medium text-ink-2">Save as note</h2>
                <div className="flex gap-2">
                  <input
                    value={noteTitle}
                    onChange={(e) => setNoteTitle(e.target.value)}
                    placeholder="Playground variant"
                    className={field}
                    aria-label="Note title"
                  />
                  <button
                    type="button"
                    onClick={() => void onSave()}
                    disabled={!projectId}
                    className="h-9 shrink-0 rounded-lg border border-line bg-panel px-3 text-[13px] text-ink hover:bg-hover disabled:opacity-40"
                  >
                    Save
                  </button>
                </div>
                <p className="mt-1 text-[11.5px] text-ink-3">Saved to Memory as an unpinned project note: kept for reference, never added to prompts.</p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
