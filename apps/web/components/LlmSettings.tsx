"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import Modal from "./Modal";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import { useToast } from "./Toasts";
import { Pencil, Plus, Trash2 } from "lucide-react";

interface LlmSettingsContextValue {
  openLlmSettings: (projectId?: string) => void;
}

const LlmSettingsContext = createContext<LlmSettingsContextValue | null>(null);

export function useLlmSettings(): LlmSettingsContextValue {
  const context = useContext(LlmSettingsContext);
  if (!context) throw new Error("useLlmSettings must be used within LlmSettingsProvider");
  return context;
}

export function LlmSettingsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const openLlmSettings = useCallback((projectId?: string) => {
    setProjectId(projectId);
    setOpen(true);
  }, []);

  return (
    <LlmSettingsContext.Provider value={{ openLlmSettings }}>
      {children}
      <LlmSettingsModal open={open} onClose={() => setOpen(false)} projectId={projectId} onProjectChange={setProjectId} />
    </LlmSettingsContext.Provider>
  );
}

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

function LlmSettingsModal({
  open,
  onClose,
  projectId,
  onProjectChange,
}: {
  open: boolean;
  onClose: () => void;
  projectId?: string;
  onProjectChange: (projectId?: string) => void;
}) {
  const projects = useQuery(api.projects.list, open ? {} : "skip");
  const providers = useQuery(api.llmProviders.list, open ? {} : "skip");
  const toast = useToast();
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState("");

  useEffect(() => {
    if (!open) {
      setForm(emptyForm);
      setEditingId(null);
      setConfirmReq(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (projects && projects.length > 0 && !projectId) {
      onProjectChange(projects[0]._id);
    }
  }, [open, projects, projectId, onProjectChange]);

  if (!open) return null;

  const sorted = providers ? [...providers].sort((a, b) => a.priority - b.priority) : undefined;

  async function fetchModels() {
    if (!form.baseUrl.trim()) {
      setModelError("Isi Base URL dulu");
      return;
    }
    if (!form.apiKey.trim() && !editingId) {
      setModelError("Isi Base URL + API key dulu");
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
      if (ids.length === 0) setModelError("Provider tidak return daftar model");
    } catch (e: any) {
      setModelError(e instanceof Error ? e.message : "Gagal fetch model");
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

  const inputCls =
    "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800";

  return (
    <Modal title="LLM Settings" onClose={onClose} maxWidth="max-w-2xl">
      <ConfirmDialog request={confirmReq} onCancel={() => setConfirmReq(null)} onConfirm={() => confirmReq?.onOk()} />
      <div className="mt-4 max-h-[70vh] overflow-y-auto pr-1">
        <div className="grid gap-4">
          <section className="rounded-2xl border border-[#ebe9f0] bg-white/70 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
            <h2 className="text-sm font-semibold">Global LLM</h2>
            <p className="mt-1 text-xs text-gray-500">
              Satu provider pool global untuk semua project. Lower priority number = tried first (fallback). Weight balances
              load across same-priority providers. Model patterns like <code>gpt-4*</code> route matching models here.
            </p>
          </section>

          <section className="rounded-2xl border border-[#ebe9f0] bg-white/70 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
              <h2 className="text-sm font-semibold">{editingId ? "Edit provider" : "Add provider"}</h2>
              <form onSubmit={handleSubmit} className="mt-3 grid grid-cols-2 gap-3 text-sm">
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
                  <select
                    value={form.provider}
                    onChange={(e) => setForm({ ...form, provider: e.target.value })}
                    className={inputCls}
                  >
                    <option value="anthropic">Anthropic</option>
                    <option value="openai">OpenAI</option>
                    <option value="openai-compatible">OpenAI-compatible</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  Model
                  <div className="flex gap-2">
                    {modelOptions.length > 0 ? (
                      <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className={inputCls}>
                        <option value="">Pilih model…</option>
                        {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    ) : (
                      <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="nous / gpt-4o-mini" className={inputCls} />
                    )}
                    <button type="button" onClick={fetchModels} disabled={modelLoading} className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 disabled:opacity-50">
                      {modelLoading ? "…" : "Fetch"}
                    </button>
                  </div>
                  {modelError && <span className="text-xs text-rose-500">{modelError}</span>}
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
                  API key env (fallback)
                  <input
                    value={form.apiKeyEnv}
                    onChange={(e) => setForm({ ...form, apiKeyEnv: e.target.value })}
                    placeholder="LLM_API_KEY"
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
                <label className="grid gap-1">
                  Model patterns (comma-separated)
                  <input
                    value={form.modelPatterns}
                    onChange={(e) => setForm({ ...form, modelPatterns: e.target.value })}
                    placeholder="gpt-4*, claude-* — kosongkan = semua model"
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
              <h2 className="text-sm font-semibold">Provider pool</h2>
              {sorted === undefined && <p className="mt-2 text-xs text-gray-400">Loading…</p>}
              {sorted && sorted.length === 0 && (
                <p className="mt-2 text-xs text-gray-500">
                  Belum ada provider. Tambahkan provider pertama di atas — API key dibaca dari env var yang kamu isi di
                  field &quot;API key env name&quot;.
                </p>
              )}
              <div className="mt-3 grid gap-2">
                {(sorted ?? []).map((p) => (
                  <div
                    key={p._id}
                    className="flex items-center gap-3 rounded-xl border border-[#e5e3eb] px-3 py-2.5 text-sm dark:border-gray-700"
                  >
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
                      </div>
                      <div className="mt-0.5 truncate text-xs text-gray-500">
                        {p.provider} · {p.model} · {p.baseUrl} · {p.apiKeyEnv}
                        {(p.modelPatterns?.length ?? 0) > 0 && ` · patterns: ${p.modelPatterns!.join(", ")}`}
                      </div>
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
                ))}
              </div>
            </section>
        </div>
      </div>
    </Modal>
  );
}
