"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "./Toasts";
import {
  STRENGTH_TAGS,
  type CapabilityOverrideRow,
  type CapabilitySource,
  type ModelCapabilities,
  type StrengthTag,
  type ToolCallingMode,
} from "@/api/convex/lib/modelCapabilities";

/**
 * Model Capability Registry (plan 027) in LLM settings: each registered
 * model's resolved capabilities and where each one came from, an override
 * editor (global, or for the selected project), and the manual probe (one
 * JSON-mode call + one tool-call test, run only when clicked). Overrides
 * are ordinary authorized mutations; the probe decrypts a provider key, so
 * it goes through the server route like the other provider operations.
 */

type Tri = "inherit" | "yes" | "no";
type Scope = "global" | "project";

const SOURCE_LABEL: Record<CapabilitySource, string> = {
  project: "project override",
  global: "override",
  probe: "probe",
  registry: "model settings",
  builtin: "built-in",
  unknown: "unknown",
};

const BOOL_FIELDS = [
  ["structuredOutput", "Structured output"],
  ["vision", "Vision"],
  ["supportsStreaming", "Streaming"],
  ["supportsCancellation", "Cancellation"],
] as const;

type Form = {
  structuredOutput: Tri;
  vision: Tri;
  supportsStreaming: Tri;
  supportsCancellation: Tri;
  toolCalling: "inherit" | ToolCallingMode;
  maxContextTokens: string;
  costPer1kIn: string;
  costPer1kOut: string;
  strengths: StrengthTag[] | null;
};

const triOf = (value: boolean | undefined): Tri => (value === undefined ? "inherit" : value ? "yes" : "no");

function formFrom(row: CapabilityOverrideRow | null): Form {
  return {
    structuredOutput: triOf(row?.structuredOutput),
    vision: triOf(row?.vision),
    supportsStreaming: triOf(row?.supportsStreaming),
    supportsCancellation: triOf(row?.supportsCancellation),
    toolCalling: row?.toolCalling ?? "inherit",
    maxContextTokens: row?.maxContextTokens !== undefined ? String(row.maxContextTokens) : "",
    costPer1kIn: row?.costPer1kIn !== undefined ? String(row.costPer1kIn) : "",
    costPer1kOut: row?.costPer1kOut !== undefined ? String(row.costPer1kOut) : "",
    strengths: row?.strengths ?? null,
  };
}

function summary(c: ModelCapabilities): string {
  return [
    c.structuredOutput ? "JSON" : "no JSON",
    c.toolCalling === "none" ? "no tools" : c.toolCalling === "markup" ? "tools (markup)" : "tools",
    c.vision ? "vision" : null,
    `${Math.round(c.maxContextTokens / 1000)}k context`,
    c.strengths.length ? c.strengths.join(", ") : null,
    c.costPer1kIn !== null || c.costPer1kOut !== null ? `$${c.costPer1kIn ?? "–"} / $${c.costPer1kOut ?? "–"} per 1k` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

async function probeModel(payload: Record<string, unknown>) {
  const res = await fetch("/api/llm-providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "probeModel", ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
  return data.probe as { structuredOutput?: boolean; toolCalling?: ToolCallingMode; errors?: string[] };
}

export default function ModelCapabilitiesSection({ projectId }: { projectId?: string }) {
  const toast = useToast();
  const data = useQuery(api.modelCapabilities.list, projectId ? { projectId: projectId as never } : {});
  const setOverride = useMutation(api.modelCapabilities.setOverride);
  const [editing, setEditing] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>("global");
  const [form, setForm] = useState<Form>(formFrom(null));
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState<string | null>(null);

  type Row = NonNullable<typeof data>["models"][number];

  function startEdit(row: Row, nextScope: Scope) {
    setEditing(row.key);
    setScope(nextScope);
    setForm(formFrom((nextScope === "project" ? row.project : row.global) as CapabilityOverrideRow | null));
  }

  async function save(row: Row) {
    setSaving(true);
    try {
      const args: Record<string, unknown> = { modelId: row.modelId, ...(scope === "project" && projectId ? { projectId } : {}) };
      const clear: string[] = [];
      for (const [field] of BOOL_FIELDS) {
        const value = form[field];
        if (value === "inherit") clear.push(field);
        else args[field] = value === "yes";
      }
      if (form.toolCalling === "inherit") clear.push("toolCalling");
      else args.toolCalling = form.toolCalling;
      for (const field of ["maxContextTokens", "costPer1kIn", "costPer1kOut"] as const) {
        const raw = form[field].trim();
        if (!raw) clear.push(field);
        else {
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) throw new Error(`${field} must be a number`);
          args[field] = n;
        }
      }
      if (form.strengths === null) clear.push("strengths");
      else args.strengths = form.strengths;
      await setOverride({ ...args, clear } as Parameters<typeof setOverride>[0]);
      toast("success", "Capabilities saved", row.modelId);
      setEditing(null);
    } catch (err) {
      toast("error", "Couldn't save capabilities", err instanceof Error ? err.message : "");
    } finally {
      setSaving(false);
    }
  }

  async function reset(row: Row) {
    setSaving(true);
    try {
      await setOverride({
        modelId: row.modelId,
        ...(scope === "project" && projectId ? { projectId: projectId as never } : {}),
        clear: ["structuredOutput", "toolCalling", "vision", "maxContextTokens", "supportsStreaming", "supportsCancellation", "strengths", "costPer1kIn", "costPer1kOut"],
      });
      toast("success", "Override cleared", row.modelId);
      setEditing(null);
    } catch (err) {
      toast("error", "Couldn't clear the override", err instanceof Error ? err.message : "");
    } finally {
      setSaving(false);
    }
  }

  async function probe(row: Row) {
    setProbing(row.key);
    try {
      const result = await probeModel({ providerId: row.providerId, modelId: row.modelId });
      const verdict = [
        result.structuredOutput === undefined ? "JSON: no verdict" : `JSON: ${result.structuredOutput ? "yes" : "no"}`,
        result.toolCalling === undefined ? "tools: no verdict" : `tools: ${result.toolCalling}`,
      ].join(" · ");
      toast(result.errors?.length ? "error" : "success", `Probe finished: ${verdict}`, result.errors?.join("; ") ?? row.modelId);
    } catch (err) {
      toast("error", "Probe failed", err instanceof Error ? err.message : "");
    } finally {
      setProbing(null);
    }
  }

  const control =
    "h-[28px] rounded-md border border-line bg-panel px-2 text-[12.5px] text-ink outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40";
  const button =
    "rounded-md border border-line px-2 py-1 text-[12px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50";

  return (
    <section aria-labelledby="model-capabilities-heading" className="rounded-xl border border-line bg-panel">
      <header className="px-4 pt-3.5">
        <h2 id="model-capabilities-heading" className="text-[14px] font-semibold text-ink">
          Model capabilities
        </h2>
        <p className="mt-0.5 text-[12px] text-ink-3">
          The router picks the first model in the pool that has what a call needs (JSON for planning, tools for code changes, vision for visual QA). Order: project override → override → probe → model settings → built-in → unknown.
        </p>
      </header>
      {data === undefined ? (
        <p className="px-4 py-3 text-[13px] text-ink-3">Loading…</p>
      ) : data.models.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-ink-3">Register a model on a connection first.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line border-t border-line">
          {data.models.map((row) => (
            <li key={row.key} className="px-4 py-2.5">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-ink">
                    {row.displayName || row.modelId}
                    <span className="text-ink-3"> · {row.connectionName}</span>
                  </p>
                  <p className="mt-0.5 text-[12px] text-ink-2">{summary(row.capabilities)}</p>
                  <p className="mt-0.5 text-[11.5px] text-ink-3">
                    JSON from {SOURCE_LABEL[row.sources.structuredOutput]} · tools from {SOURCE_LABEL[row.sources.toolCalling]} · context from{" "}
                    {SOURCE_LABEL[row.sources.maxContextTokens]}
                    {row.probe
                      ? ` · probed ${new Date(row.probe.at).toLocaleString()}${row.probe.errors?.length ? ` (${row.probe.errors.join("; ")})` : ""}`
                      : " · never probed"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button type="button" className={button} disabled={probing !== null} onClick={() => void probe(row)}>
                    {probing === row.key ? "Probing…" : "Probe"}
                  </button>
                  <button
                    type="button"
                    className={button}
                    onClick={() => (editing === row.key ? setEditing(null) : startEdit(row, "global"))}
                  >
                    {editing === row.key ? "Close" : "Edit"}
                  </button>
                </div>
              </div>

              {editing === row.key && (
                <div className="mt-2.5 grid gap-2.5 border-t border-line pt-2.5 text-[12.5px]">
                  {projectId && (
                    <label className="flex items-center gap-2 text-ink-2">
                      Applies to
                      <select
                        className={control}
                        value={scope}
                        onChange={(e) => startEdit(row, e.target.value as Scope)}
                      >
                        <option value="global">All projects</option>
                        <option value="project">This project only</option>
                      </select>
                    </label>
                  )}
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {BOOL_FIELDS.map(([field, label]) => (
                      <label key={field} className="grid gap-1 text-ink-2">
                        {label}
                        <select className={control} value={form[field]} onChange={(e) => setForm({ ...form, [field]: e.target.value as Tri })}>
                          <option value="inherit">Inherit ({row.capabilities[field] ? "yes" : "no"})</option>
                          <option value="yes">Yes</option>
                          <option value="no">No</option>
                        </select>
                      </label>
                    ))}
                    <label className="grid gap-1 text-ink-2">
                      Tool calling
                      <select
                        className={control}
                        value={form.toolCalling}
                        onChange={(e) => setForm({ ...form, toolCalling: e.target.value as Form["toolCalling"] })}
                      >
                        <option value="inherit">Inherit ({row.capabilities.toolCalling})</option>
                        <option value="native">Native</option>
                        <option value="markup">Markup (parsed from text)</option>
                        <option value="none">None</option>
                      </select>
                    </label>
                    <label className="grid gap-1 text-ink-2">
                      Max context tokens
                      <input
                        className={control}
                        type="number"
                        min="1"
                        placeholder={String(row.capabilities.maxContextTokens)}
                        value={form.maxContextTokens}
                        onChange={(e) => setForm({ ...form, maxContextTokens: e.target.value })}
                      />
                    </label>
                    <label className="grid gap-1 text-ink-2">
                      Cost in / 1k
                      <input
                        className={control}
                        type="number"
                        min="0"
                        step="any"
                        placeholder={row.capabilities.costPer1kIn !== null ? String(row.capabilities.costPer1kIn) : "unknown"}
                        value={form.costPer1kIn}
                        onChange={(e) => setForm({ ...form, costPer1kIn: e.target.value })}
                      />
                    </label>
                    <label className="grid gap-1 text-ink-2">
                      Cost out / 1k
                      <input
                        className={control}
                        type="number"
                        min="0"
                        step="any"
                        placeholder={row.capabilities.costPer1kOut !== null ? String(row.capabilities.costPer1kOut) : "unknown"}
                        value={form.costPer1kOut}
                        onChange={(e) => setForm({ ...form, costPer1kOut: e.target.value })}
                      />
                    </label>
                  </div>
                  <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ink-2">
                    <legend className="mb-1 text-ink-2">Strengths</legend>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={form.strengths === null}
                        onChange={(e) => setForm({ ...form, strengths: e.target.checked ? null : [...row.capabilities.strengths] })}
                      />
                      Inherit
                    </label>
                    {STRENGTH_TAGS.map((tag) => (
                      <label key={tag} className={`flex items-center gap-1.5 ${form.strengths === null ? "opacity-50" : ""}`}>
                        <input
                          type="checkbox"
                          disabled={form.strengths === null}
                          checked={(form.strengths ?? row.capabilities.strengths).includes(tag)}
                          onChange={(e) => {
                            const current = form.strengths ?? [];
                            setForm({ ...form, strengths: e.target.checked ? [...current, tag] : current.filter((t) => t !== tag) });
                          }}
                        />
                        {tag}
                      </label>
                    ))}
                  </fieldset>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void save(row)}
                      className="rounded-md bg-ink px-3 py-1.5 text-[12.5px] font-medium text-canvas outline-none transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                    <button type="button" disabled={saving} className={button} onClick={() => void reset(row)}>
                      Clear override
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {data && data.orphans.length > 0 && (
        <p className="border-t border-line px-4 py-2.5 text-[12px] text-ink-3">
          Overrides kept for models no longer registered: {data.orphans.join(", ")}.
        </p>
      )}
    </section>
  );
}
