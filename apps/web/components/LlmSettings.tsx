"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import { useToast } from "./Toasts";
import { OpencodeModelField } from "./OpencodeModelField";
import { Pencil, Plus, Trash2 } from "lucide-react";

type Provider = {
  _id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  priority: number;
  weight: number;
  modelPatterns?: string[];
  isEnabled?: boolean;
  apiKeyConfigured?: boolean;
};

type ModelRow = {
  _id: string;
  providerId: string;
  modelId: string;
  displayName?: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  inputPricePer1k?: number;
  outputPricePer1k?: number;
  isAvailable: boolean;
};

const emptyForm = {
  name: "",
  provider: "anthropic",
  model: "",
  baseUrl: "",
  apiKeyEnv: "",
  apiKey: "",
  priority: "10",
  weight: "100",
  modelPatterns: "",
  isEnabled: true,
};

const emptyModelForm = {
  providerId: "",
  modelId: "",
  displayName: "",
  contextWindow: "",
  supportsTools: false,
  supportsReasoning: false,
  inputPricePer1k: "",
  outputPricePer1k: "",
  isAvailable: true,
};

/**
 * Provider writes and model discovery go through the server-side route
 * (/api/llm-providers): the Convex mutations require the service token,
 * which lives only in the web server's environment, and model fetching
 * must not send a provider key from the browser to an arbitrary baseUrl.
 */
async function providerAdmin(
  op: string,
  payload: Record<string, unknown>
): Promise<any> {
  const res = await fetch("/api/llm-providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
  }
  return data;
}

export default function LlmSettingsSection({
  projectId,
  onProjectChange,
}: {
  projectId?: string;
  onProjectChange: (projectId?: string) => void;
}) {
  const projects = useQuery(api.projects.list, {});
  const providers = useQuery(api.llmProviders.list, {});
  const models = useQuery(api.llmModels.list, {});
  // Provider health (Phase 5): circuit snapshots mirrored to the backend
  // by the worker. Keyed by provider NAME, like the usage stats.
  const healthStats = useQuery(api.orchestration.providerHealthStats, {});
  // Plan 032: the app-wide selection mode (fallback | round robin).
  const selection = useQuery(api.llmSelection.get, {});
  const setSelectionMode = useMutation(api.llmSelection.set);
  // Plan 035: the app-wide OpenCode runtime and the model the CLI runs.
  const opencode = useQuery(api.opencodeSettings.get, {});
  const setOpencodeSettings = useMutation(api.opencodeSettings.set);
  const [opencodeRuntime, setOpencodeRuntime] = useState<"api" | "opencode">("api");
  const [opencodeModel, setOpencodeModel] = useState("");
  const [opencodeLoaded, setOpencodeLoaded] = useState(false);
  const toast = useToast();
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [modelForm, setModelForm] = useState(emptyModelForm);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [addingModelFor, setAddingModelFor] = useState<string | null>(null);
  const [regModelOptions, setRegModelOptions] = useState<string[]>([]);
  const [regModelLoading, setRegModelLoading] = useState(false);
  const [regModelError, setRegModelError] = useState("");
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState("");

  useEffect(() => {
    if (providers && providers.length > 0 && !modelForm.providerId && !editingModelId) {
      setModelForm((f) => ({ ...f, providerId: providers[0]._id }));
    }
  }, [providers, modelForm.providerId, editingModelId]);

  useEffect(() => {
    if (projects && projects.length > 0 && !projectId) {
      onProjectChange(projects[0]._id);
    }
  }, [projects, projectId, onProjectChange]);

  // Plan 035: seed the OpenCode fields once, so an incoming value does not
  // overwrite what the user is typing.
  useEffect(() => {
    if (!opencode || opencodeLoaded) return;
    setOpencodeRuntime(opencode.runtime);
    setOpencodeModel(opencode.model);
    setOpencodeLoaded(true);
  }, [opencode, opencodeLoaded]);

  const sorted = providers ? [...providers].sort((a, b) => a.priority - b.priority) : undefined;

  async function fetchModels() {
    if (!form.baseUrl.trim()) {
      setModelError("Base URL is required");
      return;
    }
    if (!form.apiKey.trim() && !editingId) {
      setModelError("Base URL + API key are required");
      return;
    }
    setModelLoading(true);
    setModelError("");
    try {
      // Routed through our own server + the Convex backend: the browser
      // never sends the key to the provider baseUrl directly. When editing
      // a saved provider with the key field left empty, the backend uses
      // that provider's stored key.
      const data = await providerAdmin("fetchModels", {
        baseUrl: form.baseUrl.trim(),
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        ...(!form.apiKey.trim() && editingId ? { providerId: editingId } : {}),
      });
      const ids: string[] = data.models ?? [];
      setModelOptions([...new Set(ids)].sort());
      if (ids.length === 0) setModelError("Provider returned no models");
    } catch (e: any) {
      setModelError(e instanceof Error ? e.message : "Failed to fetch models");
    } finally {
      setModelLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.model.trim() || !form.baseUrl.trim()) {
      toast("error", "Name, model, and base URL are required", "");
      return;
    }
    try {
      const payload = {
        name: form.name.trim(),
        provider: form.provider,
        model: form.model.trim(),
        baseUrl: form.baseUrl.trim(),
        apiKeyEnv: form.apiKeyEnv.trim() || "LLM_API_KEY",
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        priority: Number(form.priority) || 10,
        weight: Number(form.weight) || 100,
        modelPatterns: form.modelPatterns
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        isEnabled: form.isEnabled,
      };
      if (editingId) {
        await providerAdmin("update", { id: editingId, ...payload });
        toast("success", "Provider updated", payload.name);
      } else {
        await providerAdmin("create", payload);
        toast("success", "Provider added", payload.name);
      }
      setForm(emptyForm);
      setEditingId(null);
    } catch (err) {
      toast("error", "Failed to save provider", err instanceof Error ? err.message : "Failed to save provider");
    }
  }

  function startEdit(p: Provider) {
    setEditingId(p._id);
    setForm({
      name: p.name,
      provider: p.provider,
      model: p.model,
      baseUrl: p.baseUrl,
      apiKeyEnv: p.apiKeyEnv,
      apiKey: "",
      priority: String(p.priority),
      weight: String(p.weight),
      modelPatterns: (p.modelPatterns ?? []).join(", "),
      isEnabled: p.isEnabled !== false,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function toggleEnabled(p: Provider) {
    try {
      await providerAdmin("update", { id: p._id, isEnabled: !(p.isEnabled !== false) });
      toast("success", p.isEnabled !== false ? "Provider disabled" : "Provider enabled", p.name);
    } catch (err) {
      toast("error", "Failed to update provider", err instanceof Error ? err.message : "");
    }
  }

  function askDelete(p: Provider) {
    setConfirmReq({
      title: `Delete provider "${p.name}"?`,
      message: "This provider will be removed from the pool. Existing tasks keep their history.",
      onOk: () => {
        void (async () => {
          try {
            await providerAdmin("remove", { id: p._id });
            toast("success", "Provider deleted", p.name);
            if (editingId === p._id) {
              setEditingId(null);
              setForm(emptyForm);
            }
          } catch (err) {
            toast("error", "Failed to delete provider", err instanceof Error ? err.message : "");
          } finally {
            setConfirmReq(null);
          }
        })();
      },
    });
  }

  // ---- Model Registry (Phase 2) ----

  async function fetchRegistryModels() {
    const connection = (providers ?? []).find((p: any) => p._id === modelForm.providerId);
    if (!connection) {
      setRegModelError("Pick a connection first");
      return;
    }
    setRegModelLoading(true);
    setRegModelError("");
    try {
      // Backend-side fetch using the connection's stored (encrypted) key.
      const data = await providerAdmin("fetchModels", {
        baseUrl: connection.baseUrl,
        providerId: connection._id,
      });
      const ids: string[] = data.models ?? [];
      setRegModelOptions([...new Set(ids)].sort());
      if (ids.length === 0) setRegModelError("Provider returned no models");
    } catch (e: any) {
      setRegModelError(e instanceof Error ? e.message : "Failed to fetch models");
    } finally {
      setRegModelLoading(false);
    }
  }

  async function handleModelSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!modelForm.providerId || !modelForm.modelId.trim()) {
      toast("error", "Connection and model ID are required", "");
      return;
    }
    try {
      const payload: Record<string, unknown> = {
        modelId: modelForm.modelId.trim(),
        ...(modelForm.displayName.trim() ? { displayName: modelForm.displayName.trim() } : {}),
        ...(modelForm.contextWindow.trim() ? { contextWindow: Number(modelForm.contextWindow) } : {}),
        supportsTools: modelForm.supportsTools,
        supportsReasoning: modelForm.supportsReasoning,
        ...(modelForm.inputPricePer1k.trim() ? { inputPricePer1k: Number(modelForm.inputPricePer1k) } : {}),
        ...(modelForm.outputPricePer1k.trim() ? { outputPricePer1k: Number(modelForm.outputPricePer1k) } : {}),
        isAvailable: modelForm.isAvailable,
      };
      if (editingModelId) {
        await providerAdmin("updateModel", { id: editingModelId, ...payload });
        toast("success", "Model updated", payload.modelId as string);
      } else {
        await providerAdmin("createModel", { providerId: modelForm.providerId, ...payload });
        toast("success", "Model registered", payload.modelId as string);
      }
      setModelForm({ ...emptyModelForm, providerId: modelForm.providerId });
      setEditingModelId(null);
      setRegModelOptions([]);
    } catch (err) {
      toast("error", "Failed to save model", err instanceof Error ? err.message : "Failed to save model");
    }
  }

  function startEditModel(m: ModelRow) {
    setEditingModelId(m._id);
    setAddingModelFor(m.providerId);
    setModelForm({
      providerId: m.providerId,
      modelId: m.modelId,
      displayName: m.displayName ?? "",
      contextWindow: m.contextWindow !== undefined ? String(m.contextWindow) : "",
      supportsTools: m.supportsTools === true,
      supportsReasoning: m.supportsReasoning === true,
      inputPricePer1k: m.inputPricePer1k !== undefined ? String(m.inputPricePer1k) : "",
      outputPricePer1k: m.outputPricePer1k !== undefined ? String(m.outputPricePer1k) : "",
      isAvailable: m.isAvailable !== false,
    });
  }

  function openAddModel(providerId: string) {
    setEditingModelId(null);
    setModelForm({ ...emptyModelForm, providerId });
    setRegModelOptions([]);
    setRegModelError("");
    setAddingModelFor(providerId);
  }

  function closeModelForm() {
    const pid = modelForm.providerId;
    setEditingModelId(null);
    setAddingModelFor(null);
    setModelForm({ ...emptyModelForm, providerId: pid });
    setRegModelOptions([]);
  }

  async function toggleModelAvailable(m: ModelRow) {
    try {
      await providerAdmin("updateModel", { id: m._id, isAvailable: !(m.isAvailable !== false) });
      toast("success", m.isAvailable !== false ? "Model marked unavailable" : "Model marked available", m.modelId);
    } catch (err) {
      toast("error", "Failed to update model", err instanceof Error ? err.message : "");
    }
  }

  function askDeleteModel(m: ModelRow) {
    setConfirmReq({
      title: `Delete model "${m.modelId}"?`,
      message: "The model is removed from the registry. Agents assigned to it fall back to the connection's remaining models.",
      onOk: () => {
        void (async () => {
          try {
            await providerAdmin("removeModel", { id: m._id });
            toast("success", "Model deleted", m.modelId);
            if (editingModelId === m._id) {
              setEditingModelId(null);
              setModelForm({ ...emptyModelForm, providerId: modelForm.providerId });
            }
          } catch (err) {
            toast("error", "Failed to delete model", err instanceof Error ? err.message : "");
          } finally {
            setConfirmReq(null);
          }
        })();
      },
    });
  }

  const inputCls =
    "w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800";

  const selectionMode = selection?.mode ?? "fallback";

  async function chooseSelectionMode(mode: "fallback" | "round_robin") {
    try {
      await setSelectionMode({ mode });
      toast("success", "Selection mode updated", mode === "fallback" ? "Fallback" : "Round robin");
    } catch (err) {
      toast("error", "Failed to update selection mode", err instanceof Error ? err.message : "");
    }
  }

  async function saveOpencodeSettings() {
    try {
      await setOpencodeSettings({ runtime: opencodeRuntime, model: opencodeModel });
      toast(
        "success",
        "OpenCode runtime updated",
        opencodeRuntime === "opencode" ? "OpenCode CLI" : "Built-in (Fhara tools)"
      );
    } catch (err) {
      toast("error", "Failed to update the OpenCode runtime", err instanceof Error ? err.message : "");
    }
  }

  return (
    <>
      <ConfirmDialog request={confirmReq} onCancel={() => setConfirmReq(null)} onConfirm={() => confirmReq?.onOk()} />
      <div className="grid gap-4">
          <section className="rounded-2xl border border-[#ebe9f0] bg-white/70 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
              <h2 className="text-sm font-semibold">Selection mode</h2>
              <p className="mt-0.5 text-[12px] text-ink-3">
                How a call picks the provider it starts on. A failed provider always fails over to the next
                candidate.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                {(
                  [
                    {
                      value: "fallback" as const,
                      label: "Fallback",
                      description: "Use one provider at a time, fail over to the next on error.",
                    },
                    {
                      value: "round_robin" as const,
                      label: "Round robin",
                      description: "Rotate providers per call, still fails over.",
                    },
                  ] as const
                ).map(({ value, label, description }) => {
                  const active = selectionMode === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => void chooseSelectionMode(value)}
                      aria-pressed={active}
                      className={`rounded-lg border px-2.5 py-2 text-left text-sm transition ${
                        active
                          ? "border-brand bg-brand-soft text-brand-ink"
                          : "border-line hover:bg-hover"
                      }`}
                    >
                      <span className="block font-medium">{label}</span>
                      <span className="mt-0.5 block text-[12px] text-ink-3">{description}</span>
                    </button>
                  );
                })}
              </div>
          </section>
          <section className="rounded-2xl border border-[#ebe9f0] bg-white/70 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
              <h2 className="text-sm font-semibold">OpenCode runtime</h2>
              <p className="mt-0.5 text-[12px] text-ink-3">
                One setting for the whole app: the OpenCode CLI, its credentials and its model list live on the
                worker, so every agent runs on the same runtime. Each agent still picks its own Fhara model
                (Provider / Model) in the agent form. Changes apply to the next task.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-[12.5px] text-ink-3">
                  Runtime
                  <select
                    value={opencodeRuntime}
                    onChange={(e) => setOpencodeRuntime(e.target.value as "api" | "opencode")}
                    className={inputCls}
                    aria-label="OpenCode runtime"
                  >
                    <option value="api">Built-in (Fhara tools)</option>
                    <option value="opencode">OpenCode CLI</option>
                  </select>
                </label>
                <OpencodeModelField
                  value={opencodeModel}
                  onChange={setOpencodeModel}
                  disabled={opencodeRuntime !== "opencode"}
                />
              </div>
              <button
                type="button"
                onClick={() => void saveOpencodeSettings()}
                className="mt-3 rounded-lg bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition hover:opacity-90"
              >
                Save runtime
              </button>
          </section>
          <section className="rounded-2xl border border-[#ebe9f0] bg-white/70 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
              <h2 className="text-sm font-semibold">{editingId ? "Edit connection" : "Add connection"}</h2>
              <form onSubmit={handleSubmit} className="mt-3 grid grid-cols-2 gap-2.5 text-sm">
                <label className="grid gap-1">
                  Name
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Anthropic Primary"
                    className={inputCls}
                  />
                </label>
                <label className="grid gap-1">
                  Provider
                  <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} className={inputCls}>
                    <option value="anthropic">Anthropic</option>
                    <option value="openai">OpenAI</option>
                    <option value="openai-compatible">OpenAI-compatible</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  Base URL
                  <input
                    value={form.baseUrl}
                    onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                    placeholder="https://api.anthropic.com/v1"
                    className={inputCls}
                  />
                </label>
                <label className="grid gap-1">
                  API key
                  <input
                    type="password"
                    value={form.apiKey}
                    onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                    placeholder="sk-..."
                    className={inputCls}
                  />
                </label>
                <label className="grid gap-1">
                  Model
                  <div className="flex gap-2">
                    {modelOptions.length > 0 ? (
                      <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className={inputCls}>
                        <option value="">Choose model…</option>
                        {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    ) : (
                      <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="nous / gpt-4o-mini" className={inputCls} />
                    )}
                    <button type="button" onClick={fetchModels} disabled={modelLoading} className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700 disabled:opacity-50">
                      {modelLoading ? "…" : "Fetch"}
                    </button>
                  </div>
                  {modelError && <span className="text-xs text-rose-500">{modelError}</span>}
                </label>
                <details className="col-span-2 rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-700">
                  <summary className="cursor-pointer text-xs font-medium text-gray-500 dark:text-gray-400">Advanced</summary>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <label className="grid gap-1">
                      Priority (lower = first)
                      <input
                        value={form.priority}
                        onChange={(e) => setForm({ ...form, priority: e.target.value })}
                        type="number"
                        className={inputCls}
                      />
                    </label>
                    <label className="grid gap-1">
                      Weight (load balance)
                      <input
                        value={form.weight}
                        onChange={(e) => setForm({ ...form, weight: e.target.value })}
                        type="number"
                        className={inputCls}
                      />
                    </label>
                    <label className="col-span-2 grid gap-1">
                      Model patterns (comma-separated)
                      <input
                        value={form.modelPatterns}
                        onChange={(e) => setForm({ ...form, modelPatterns: e.target.value })}
                        placeholder="gpt-4*, claude-* — leave empty = all models"
                        className={inputCls}
                      />
                    </label>
                    <label className="col-span-2 flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.isEnabled}
                        onChange={(e) => setForm({ ...form, isEnabled: e.target.checked })}
                      />
                      Enabled — include in pool
                    </label>
                  </div>
                </details>
                <div className="col-span-2 flex gap-2">
                  <button
                    type="submit"
                    className="flex items-center gap-1.5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-gray-900"
                  >
                    <Plus size={15} /> {editingId ? "Save changes" : "Add to pool"}
                  </button>
                  {editingId && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(null);
                        setForm(emptyForm);
                      }}
                      className="rounded-lg border border-gray-300 px-4 py-2 text-sm dark:border-gray-700"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            </section>

          <section className="rounded-2xl border border-[#ebe9f0] bg-white/70 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
              <h2 className="text-sm font-semibold">Connections</h2>
              {sorted === undefined && <p className="mt-2 text-xs text-gray-400">Loading…</p>}
              {sorted && sorted.length === 0 && (
                <p className="mt-2 text-xs text-gray-500">
                  No connections yet. Add your first connection above — the API key is read from the env var you set in the &quot;API key env&quot; field.
                </p>
              )}
              <div className="mt-3 grid gap-2">
                {(sorted ?? []).map((p) => {
                  // Circuit state for this connection (Phase 5): a row
                  // renders only when the worker has reported one.
                  const health = healthStats?.snapshots?.[p.name];
                  const circuitOpen =
                    health?.circuitOpenUntil != null &&
                    health.circuitOpenUntil > Date.now();
                  const connModels = (models ?? []).filter((m: any) => m.providerId === p._id);
                  const modelFormOpen = addingModelFor === p._id || editingModelId !== null;
                  return (
                  <div
                    key={p._id}
                    className="rounded-xl border border-[#e5e3eb] px-3 py-2.5 text-sm dark:border-gray-700"
                  >
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate">{p.name}</span>
                          <span className="rounded-full bg-[#eceaf3] px-2 py-0.5 text-[10px] font-semibold text-[#5147b4] dark:bg-white/10 dark:text-white">
                            P{p.priority}
                          </span>
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] dark:bg-white/5">
                            w{p.weight}
                          </span>
                          {p.isEnabled === false && (
                            <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-600">
                              disabled
                            </span>
                          )}
                          {p.apiKeyConfigured ? (
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                              key configured
                            </span>
                          ) : (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                              no key stored
                            </span>
                          )}
                          {health &&
                            (circuitOpen ? (
                              <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-600">
                                circuit open until{" "}
                                {new Date(health.circuitOpenUntil!).toLocaleTimeString()}
                              </span>
                            ) : (
                              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                                circuit closed
                              </span>
                            ))}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-gray-500">
                          {p.provider} · {p.model} · {p.baseUrl} · {p.apiKeyEnv}
                          {(p.modelPatterns?.length ?? 0) > 0 && ` · patterns: ${p.modelPatterns!.join(", ")}`}
                        </div>
                        {health && (
                          <div className="mt-0.5 truncate text-xs text-gray-500">
                            Health: {health.totalSuccesses} successes ·{" "}
                            {health.totalTransientFailures} transient failures
                            {health.consecutiveTransientFailures > 0 &&
                              ` · ${health.consecutiveTransientFailures} in a row`}
                            {health.lastSuccessAt &&
                              ` · last success ${new Date(health.lastSuccessAt).toLocaleTimeString()}`}
                            {health.lastFailureAt &&
                              ` · last failure ${new Date(health.lastFailureAt).toLocaleTimeString()}`}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleEnabled(p)}
                        className="rounded-lg border border-gray-200 px-2 py-1 text-xs dark:border-gray-700"
                      >
                        {p.isEnabled !== false ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        onClick={() => startEdit(p)}
                        className="rounded-lg p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800"
                        aria-label={`Edit ${p.name}`}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => askDelete(p)}
                        className="rounded-lg p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
                        aria-label={`Delete ${p.name}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    <div className="mt-2 border-t border-gray-100 pt-2 dark:border-gray-800">
                      <div className="text-xs font-semibold text-gray-500">Models ({connModels.length})</div>
                      <div className="mt-1.5 grid gap-1.5">
                        {connModels.map((m: any) => (
                          <div key={m._id} className="flex items-center gap-3 rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-white/[0.03]">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="font-medium truncate">{m.displayName || m.modelId}</span>
                                {m.displayName && <span className="text-xs text-gray-400">{m.modelId}</span>}
                                {m.isAvailable === false && (
                                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-600">
                                    unavailable
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 truncate text-xs text-gray-500">
                                {[
                                  m.contextWindow ? `ctx ${m.contextWindow}` : null,
                                  m.supportsTools ? "tools" : null,
                                  m.supportsReasoning ? "reasoning" : null,
                                  m.inputPricePer1k !== undefined || m.outputPricePer1k !== undefined
                                    ? `price in ${m.inputPricePer1k ?? "–"} / out ${m.outputPricePer1k ?? "–"} per 1k`
                                    : null,
                                ].filter(Boolean).join(" · ") || "—"}
                              </div>
                            </div>
                            <button type="button" onClick={() => toggleModelAvailable(m)} className="rounded-lg border border-gray-200 px-2 py-1 text-xs dark:border-gray-700">
                              {m.isAvailable !== false ? "Mark unavailable" : "Mark available"}
                            </button>
                            <button type="button" onClick={() => startEditModel(m)} className="rounded-lg p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800" aria-label={`Edit ${m.modelId}`}>
                              <Pencil size={14} />
                            </button>
                            <button type="button" onClick={() => askDeleteModel(m)} className="rounded-lg p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30" aria-label={`Delete ${m.modelId}`}>
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                        {connModels.length === 0 && (
                          <p className="text-xs text-gray-400">No models registered yet.</p>
                        )}
                      </div>

                      {modelFormOpen && modelForm.providerId === p._id ? (
                        <form onSubmit={handleModelSubmit} className="mt-2 grid grid-cols-2 gap-3 rounded-lg bg-gray-50 p-3 text-sm dark:bg-white/[0.03]">
                          <label className="grid gap-1">
                            Model ID
                            <div className="flex gap-2">
                              {regModelOptions.length > 0 ? (
                                <select value={modelForm.modelId} onChange={(e) => setModelForm({ ...modelForm, modelId: e.target.value })} className={inputCls}>
                                  <option value="">Choose model…</option>
                                  {regModelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                                </select>
                              ) : (
                                <input value={modelForm.modelId} onChange={(e) => setModelForm({ ...modelForm, modelId: e.target.value })} placeholder="nous / gpt-4o-mini" className={inputCls} />
                              )}
                              <button type="button" onClick={fetchRegistryModels} disabled={regModelLoading} className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 disabled:opacity-50">
                                {regModelLoading ? "…" : "Fetch"}
                              </button>
                            </div>
                            {regModelError && <span className="text-xs text-rose-500">{regModelError}</span>}
                          </label>
                          <label className="flex items-center gap-2 pt-6 text-sm">
                            <input type="checkbox" checked={modelForm.isAvailable} onChange={(e) => setModelForm({ ...modelForm, isAvailable: e.target.checked })} />
                            Available
                          </label>
                          <details className="col-span-2 rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-700">
                            <summary className="cursor-pointer text-xs font-medium text-gray-500 dark:text-gray-400">Advanced</summary>
                            <div className="mt-3 grid grid-cols-2 gap-3">
                              <label className="grid gap-1">
                                Display name (optional)
                                <input value={modelForm.displayName} onChange={(e) => setModelForm({ ...modelForm, displayName: e.target.value })} className={inputCls} />
                              </label>
                              <label className="grid gap-1">
                                Context window (tokens, optional)
                                <input value={modelForm.contextWindow} onChange={(e) => setModelForm({ ...modelForm, contextWindow: e.target.value })} type="number" min="0" className={inputCls} />
                              </label>
                              <label className="grid gap-1">
                                Input price / 1k tokens (optional)
                                <input value={modelForm.inputPricePer1k} onChange={(e) => setModelForm({ ...modelForm, inputPricePer1k: e.target.value })} type="number" min="0" step="any" className={inputCls} />
                              </label>
                              <label className="grid gap-1">
                                Output price / 1k tokens (optional)
                                <input value={modelForm.outputPricePer1k} onChange={(e) => setModelForm({ ...modelForm, outputPricePer1k: e.target.value })} type="number" min="0" step="any" className={inputCls} />
                              </label>
                              <label className="flex items-center gap-2 text-sm">
                                <input type="checkbox" checked={modelForm.supportsTools} onChange={(e) => setModelForm({ ...modelForm, supportsTools: e.target.checked })} />
                                Supports tools
                              </label>
                              <label className="flex items-center gap-2 text-sm">
                                <input type="checkbox" checked={modelForm.supportsReasoning} onChange={(e) => setModelForm({ ...modelForm, supportsReasoning: e.target.checked })} />
                                Supports reasoning
                              </label>
                            </div>
                          </details>
                          <div className="col-span-2 flex gap-2">
                            <button type="submit" className="flex items-center gap-1.5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-gray-900">
                              <Plus size={15} /> {editingModelId ? "Save model" : "Add model"}
                            </button>
                            <button
                              type="button"
                              onClick={closeModelForm}
                              className="rounded-lg border border-gray-300 px-4 py-2 text-sm dark:border-gray-700"
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openAddModel(p._id)}
                          className="mt-2 flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
                        >
                          <Plus size={13} /> Add model
                        </button>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
              {healthStats !== undefined &&
                Object.keys(healthStats.snapshots).length === 0 && (
                  <p className="mt-2 text-xs text-gray-500">
                    Circuit status fills in after the worker makes its first LLM call. The connection config above stays accurate either way.
                  </p>
                )}
            </section>
        </div>
    </>
  );
}
