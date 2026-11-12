"use client";

/**
 * Settings → LLM & Models, one page top to bottom:
 *   1. Mode — Fallback or Round robin (plan 032, app-wide).
 *   2. Providers — added from presets; the key is validated on save.
 *   3. Models — ONE ordered list across providers. The order is the
 *      fallback order; in round robin it is the rotation set and the order
 *      sets which model starts first (lib/llmOrder.ts, shared by chat and
 *      the worker). Below it: the per-role override toggle (L4, off).
 *   OpenCode (plan 038) is a special row in Providers: detected on the worker,
 *   enabled here, its models take positions in the same list; an OpenCode
 *   entry runs a subtask on the OpenCode CLI, chat skips it.
 *
 * Provider/model writes, discovery and tests go through the server-side
 * route (/api/llm-providers): the Convex mutations require the service
 * token, which lives only in the web server's environment, and a provider
 * key never travels from the browser to a provider URL.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowDown, ArrowUp, MoreHorizontal, Plus } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { findPreset, guessPreset, LLM_PROVIDER_PRESETS } from "@/api/convex/lib/llmPresets";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import Segmented from "./ui/segmented";
import { useToast } from "./Toasts";
import { OPENCODE_INSTALL_COMMAND, isOpencodeConnection } from "@/api/convex/lib/opencodeProvider";
import { relativeTime } from "@/lib/runFormat";
import { RoleOverrideKnob } from "./settings/RoleOverrideKnob";
import { popoverClass, usePopover } from "./shell/usePopover";
import {
  effectiveOrder,
  formForPreset,
  hostOf,
  moveItem,
  opencodeStatusLine,
  opencodeUnavailableReason,
  providerFormError,
  providerPayload,
  sameOrder,
  type ProviderFormState,
} from "@/lib/llmModelList";

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
  presetId?: string;
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
  position?: number;
};

type TestResult = { ok: boolean; connection: string; model?: string; latencyMs: number; detail: string };

const FIELD =
  "w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[14px] text-ink outline-none transition focus:border-ink-3 disabled:opacity-40";
const LABEL = "grid gap-1.5 text-[12.5px] text-ink-3";
const HINT = "text-[12px] text-ink-3";
const PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-40";
const GHOST =
  "inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[12.5px] text-ink-2 transition hover:bg-hover hover:text-ink disabled:opacity-40";
const ICON =
  "rounded-md p-1.5 text-ink-3 transition hover:bg-hover hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent";
const ERROR_TEXT = "text-[12.5px] text-red-600 dark:text-red-400";

/**
 * One row's secondary actions, tucked behind a small menu so a list stays
 * quiet. Every item is a real control with a working handler.
 */
function RowMenu({
  label,
  items,
}: {
  label: string;
  items: Array<{ label: string; onClick: () => void; danger?: boolean }>;
}) {
  const { open, toggle, setOpen, ref } = usePopover<HTMLDivElement>();
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-8 min-w-8 items-center justify-center rounded-lg text-ink-3 transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div role="menu" className={`${popoverClass} right-0 mt-1 min-w-[11rem] p-1`}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className={`block w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition hover:bg-hover ${
                item.danger ? "text-red-600 dark:text-red-400" : "text-ink-2 hover:text-ink"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const emptyModelForm = {
  providerId: "",
  modelId: "",
  displayName: "",
  contextWindow: "",
  inputPricePer1k: "",
  outputPricePer1k: "",
  supportsTools: false,
  supportsReasoning: false,
};

async function providerAdmin(op: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch("/api/llm-providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
  return data;
}

function testLine(result: TestResult): string {
  const where = result.model ? `${result.model} on ${result.connection}` : result.connection;
  return result.ok
    ? `OK · ${where} · ${result.latencyMs} ms${result.detail && result.detail !== "OK" ? ` · ${result.detail}` : ""}`
    : `Failed · ${where} · ${result.detail}`;
}

export default function LlmSettingsSection({
  projectId,
  onProjectChange,
}: {
  projectId?: string;
  onProjectChange: (projectId?: string) => void;
}) {
  const projects = useQuery(api.projects.list, {});
  const providers = useQuery(api.llmProviders.list, {}) as Provider[] | undefined;
  const models = useQuery(api.llmModels.list, {}) as ModelRow[] | undefined;
  const encryption = useQuery(api.llmProviders.encryptionStatus, {});
  const healthStats = useQuery(api.orchestration.providerHealthStats, {});
  const selection = useQuery(api.llmSelection.get, {});
  const setSelectionMode = useMutation(api.llmSelection.set);
  // Plan 038: the OpenCode provider row (detection, enable, test).
  const opencode = useQuery(api.opencodeProvider.status, {});
  const opencodeCatalog = useQuery(api.opencodeModels.list, {});
  const requestOpencodeCheck = useMutation(api.opencodeModels.requestRefresh);
  const requestOpencodeTest = useMutation(api.opencodeModels.requestTest);
  const toast = useToast();

  const [opencodeBusy, setOpencodeBusy] = useState(false);
  // The list row whose Test asked the worker (the probe result is global).
  const [opencodeTestKey, setOpencodeTestKey] = useState<string | null>(null);
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);

  // Provider form (add or edit).
  const [providerFormOpen, setProviderFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderFormState>(() => formForPreset(LLM_PROVIDER_PRESETS[0]));
  const [showWeightPatterns, setShowWeightPatterns] = useState(false);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerError, setProviderError] = useState("");

  // Model form (add).
  const [modelFormOpen, setModelFormOpen] = useState(false);
  const [modelForm, setModelForm] = useState(emptyModelForm);
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({});
  const [modelOptionsLoading, setModelOptionsLoading] = useState(false);
  const [modelOptionsError, setModelOptionsError] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  // Order + tests.
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult | "running">>({});

  useEffect(() => {
    if (projects && projects.length > 0 && !projectId) onProjectChange(projects[0]._id);
  }, [projects, projectId, onProjectChange]);

  const providerById = useMemo(() => new Map((providers ?? []).map((p) => [p._id, p])), [providers]);
  const serverOrder = useMemo(() => (models ?? []).map((m) => m._id), [models]);
  const order = effectiveOrder(serverOrder, pendingOrder);
  const modelById = useMemo(() => new Map((models ?? []).map((m) => [m._id, m])), [models]);
  const orderedModels = order.map((id) => modelById.get(id)).filter((m): m is ModelRow => Boolean(m));

  useEffect(() => {
    if (pendingOrder && sameOrder(pendingOrder, serverOrder)) setPendingOrder(null);
  }, [pendingOrder, serverOrder]);

  const selectionMode = selection?.mode ?? "fallback";
  const preset = findPreset(form.presetId);
  const keyStorageMissing = encryption !== undefined && !encryption.configured;

  async function chooseSelectionMode(mode: "fallback" | "round_robin") {
    try {
      await setSelectionMode({ mode });
    } catch (err) {
      toast("error", "Failed to update the mode", err instanceof Error ? err.message : "");
    }
  }

  // ---- Providers ----

  function openAddProvider() {
    setEditingId(null);
    setForm(formForPreset(LLM_PROVIDER_PRESETS[0]));
    setShowWeightPatterns(false);
    setProviderError("");
    setProviderFormOpen(true);
  }

  function openEditProvider(p: Provider) {
    const known = findPreset(p.presetId) ?? guessPreset(p);
    setEditingId(p._id);
    setForm({
      presetId: known.id,
      name: p.name,
      apiKey: "",
      baseUrl: p.baseUrl,
      provider: p.provider,
      apiKeyEnv: p.apiKeyEnv,
      weight: String(p.weight ?? 100),
      modelPatterns: (p.modelPatterns ?? []).join(", "),
      isEnabled: p.isEnabled !== false,
    });
    // Weight and patterns stay hidden unless this provider already uses them.
    setShowWeightPatterns((p.weight ?? 100) !== 100 || (p.modelPatterns?.length ?? 0) > 0);
    setProviderError("");
    setProviderFormOpen(true);
  }

  function closeProviderForm() {
    setProviderFormOpen(false);
    setEditingId(null);
    setProviderError("");
  }

  function pickPreset(id: string) {
    const next = findPreset(id);
    if (!next) return;
    setForm((current) => formForPreset(next, current));
  }

  async function saveProvider(e: React.FormEvent) {
    e.preventDefault();
    const problem = providerFormError(form, preset, Boolean(editingId));
    if (problem) {
      setProviderError(problem);
      return;
    }
    setProviderSaving(true);
    setProviderError("");
    const payload = providerPayload(form);
    try {
      if (editingId) {
        // A new key is validated before it replaces the stored one.
        if (form.apiKey.trim()) {
          await providerAdmin("fetchModels", {
            baseUrl: payload.baseUrl,
            provider: payload.provider,
            apiKey: form.apiKey.trim(),
          });
        }
        await providerAdmin("update", { id: editingId, ...payload });
        toast("success", "Provider saved", String(payload.name));
        closeProviderForm();
      } else {
        const data = await providerAdmin("validateAndCreate", payload);
        const fetched: string[] = data.models ?? [];
        setModelOptions((current) => ({ ...current, [data.id]: fetched }));
        toast(
          "success",
          "Provider added",
          fetched.length > 0 ? `${fetched.length} models available. Add the ones you want to the list.` : String(payload.name)
        );
        closeProviderForm();
        // Next step of the flow: pick a model from this provider.
        setModelForm({ ...emptyModelForm, providerId: data.id });
        setModelOptionsError("");
        setModelFormOpen(true);
      }
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : "Failed to save the provider");
    } finally {
      setProviderSaving(false);
    }
  }

  function askRemoveProvider(p: Provider) {
    const count = (models ?? []).filter((m) => m.providerId === p._id).length;
    setConfirmReq({
      title: `Remove provider "${p.name}"?`,
      message: `Its ${count} model${count === 1 ? "" : "s"} leave the list too. Agents set to this provider use the global order instead. Existing tasks keep their history.`,
      confirmLabel: "Remove",
      onOk: () => {
        void (async () => {
          try {
            await providerAdmin("remove", { id: p._id });
            toast("success", "Provider removed", p.name);
            if (editingId === p._id) closeProviderForm();
          } catch (err) {
            toast("error", "Failed to remove the provider", err instanceof Error ? err.message : "");
          } finally {
            setConfirmReq(null);
          }
        })();
      },
    });
  }

  async function runTest(key: string, providerId: string, modelRowId?: string) {
    if (isOpencodeConnection(providerById.get(providerId))) {
      await testOpencode(key, modelRowId ? modelById.get(modelRowId)?.modelId : undefined);
      return;
    }
    setTests((current) => ({ ...current, [key]: "running" }));
    try {
      const result: TestResult = await providerAdmin("testModel", {
        providerId,
        ...(modelRowId ? { modelRowId } : {}),
      });
      setTests((current) => ({ ...current, [key]: result }));
    } catch (err) {
      setTests((current) => ({
        ...current,
        [key]: { ok: false, connection: providerById.get(providerId)?.name ?? "?", latencyMs: 0, detail: err instanceof Error ? err.message : "Test failed" },
      }));
    }
  }

  // ---- OpenCode (plan 038) ----

  async function setOpencodeEnabled(enabled: boolean) {
    setOpencodeBusy(true);
    try {
      const data = await providerAdmin("setOpencodeEnabled", { enabled });
      toast(
        "success",
        enabled ? "OpenCode enabled" : "OpenCode disabled",
        data.carriedOver
          ? `Your OpenCode runtime model ${data.carriedOver} is now the first entry of the list.`
          : enabled
            ? "Add OpenCode models to the list; tasks run them on the OpenCode CLI."
            : "Tasks skip its models and use the next one in the list."
      );
    } catch (err) {
      toast("error", "Failed to update OpenCode", err instanceof Error ? err.message : "");
    } finally {
      setOpencodeBusy(false);
    }
  }

  async function checkOpencodeAgain() {
    try {
      const { requested } = await requestOpencodeCheck({});
      if (requested === 0) toast("error", "No worker has reported yet", "Start the worker; it checks for OpenCode at startup.");
    } catch (err) {
      toast("error", "Failed to ask the worker", err instanceof Error ? err.message : "");
    }
  }

  async function testOpencode(key: string, model?: string) {
    try {
      const { requested } = await requestOpencodeTest({ ...(model ? { model } : {}) });
      if (!requested) {
        toast("error", "No worker has reported yet", "Start the worker, then test again.");
        return;
      }
      setOpencodeTestKey(key);
    } catch (err) {
      toast("error", "Failed to ask the worker", err instanceof Error ? err.message : "");
    }
  }

  // ---- Models ----

  async function loadModelOptions(providerId: string) {
    if (!providerId) return;
    const connection = providerById.get(providerId);
    if (!connection) return;
    // OpenCode lists its models through the worker catalog, not over HTTP.
    if (isOpencodeConnection(connection)) return;
    setModelOptionsLoading(true);
    setModelOptionsError("");
    try {
      const data = await providerAdmin("fetchModels", { baseUrl: connection.baseUrl, providerId });
      setModelOptions((current) => ({ ...current, [providerId]: data.models ?? [] }));
      if ((data.models ?? []).length === 0) setModelOptionsError("The provider listed no models. Type the model id.");
    } catch (err) {
      setModelOptionsError(
        `Could not list models (${err instanceof Error ? err.message : "error"}). Type the model id.`
      );
    } finally {
      setModelOptionsLoading(false);
    }
  }

  function openAddModel() {
    const first = (sortedProviders ?? [])[0]?._id ?? opencode?.providerId ?? "";
    setModelForm({ ...emptyModelForm, providerId: first });
    setModelOptionsError("");
    setModelFormOpen(true);
  }

  useEffect(() => {
    if (!modelFormOpen || !modelForm.providerId) return;
    if (modelOptions[modelForm.providerId] !== undefined) return;
    void loadModelOptions(modelForm.providerId);
    // loadModelOptions is stable enough for this one-shot fetch per provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelFormOpen, modelForm.providerId]);

  async function saveModel(e: React.FormEvent) {
    e.preventDefault();
    const modelId = modelForm.modelId.trim();
    if (!modelForm.providerId || !modelId) {
      setModelOptionsError("Pick a provider and a model.");
      return;
    }
    try {
      await providerAdmin("createModel", {
        providerId: modelForm.providerId,
        modelId,
        ...(modelForm.displayName.trim() ? { displayName: modelForm.displayName.trim() } : {}),
        ...(modelForm.contextWindow.trim() ? { contextWindow: Number(modelForm.contextWindow) } : {}),
        ...(modelForm.inputPricePer1k.trim() ? { inputPricePer1k: Number(modelForm.inputPricePer1k) } : {}),
        ...(modelForm.outputPricePer1k.trim() ? { outputPricePer1k: Number(modelForm.outputPricePer1k) } : {}),
        ...(modelForm.supportsTools ? { supportsTools: true } : {}),
        ...(modelForm.supportsReasoning ? { supportsReasoning: true } : {}),
        isAvailable: true,
      });
      toast("success", "Model added to the end of the list", modelId);
      setModelForm({ ...emptyModelForm, providerId: modelForm.providerId });
    } catch (err) {
      setModelOptionsError(err instanceof Error ? err.message : "Failed to add the model");
    }
  }

  async function move(index: number, delta: number) {
    const next = moveItem(order, index, delta);
    if (sameOrder(next, order)) return;
    setPendingOrder(next);
    try {
      await providerAdmin("reorderModels", { orderedIds: next });
    } catch (err) {
      setPendingOrder(null);
      toast("error", "Failed to reorder", err instanceof Error ? err.message : "");
    }
  }

  async function toggleModel(m: ModelRow) {
    try {
      await providerAdmin("updateModel", { id: m._id, isAvailable: !m.isAvailable });
    } catch (err) {
      toast("error", "Failed to update the model", err instanceof Error ? err.message : "");
    }
  }

  function askRemoveModel(m: ModelRow) {
    setConfirmReq({
      title: `Remove "${m.modelId}" from the list?`,
      message: "Calls skip it from now on. Agents set to this model use the provider's next model.",
      confirmLabel: "Remove",
      onOk: () => {
        void (async () => {
          try {
            await providerAdmin("removeModel", { id: m._id });
            toast("success", "Model removed", m.modelId);
          } catch (err) {
            toast("error", "Failed to remove the model", err instanceof Error ? err.message : "");
          } finally {
            setConfirmReq(null);
          }
        })();
      },
    });
  }

  // HTTP connections; the OpenCode row is shown on its own (plan 038).
  const sortedProviders = providers
    ? [...providers].filter((p) => !isOpencodeConnection(p)).sort((a, b) => a.priority - b.priority)
    : undefined;
  const opencodeRowId = opencode?.providerId ?? null;
  const addingOpencode = opencodeRowId !== null && modelForm.providerId === opencodeRowId;
  const options = addingOpencode ? opencodeCatalog?.models ?? [] : modelOptions[modelForm.providerId] ?? [];
  const modelPreset = findPreset(providerById.get(modelForm.providerId)?.presetId);
  const opencodeLine = opencodeStatusLine(opencode);
  const opencodeOff = opencodeUnavailableReason(opencode);
  const hasOpencodeEntries = (models ?? []).some((m) => m.providerId === opencodeRowId);
  const canAddModel = (sortedProviders?.length ?? 0) > 0 || opencodeRowId !== null;
  const opencodeTest = opencode?.test ?? null;

  return (
    <>
      <ConfirmDialog request={confirmReq} onCancel={() => setConfirmReq(null)} onConfirm={() => confirmReq?.onOk()} />
      <div className="mx-auto grid max-w-3xl gap-8">
        <header className="grid gap-1">
          <h2 className="text-[24px] font-semibold tracking-tight text-ink">LLM &amp; Models</h2>
          <p className={HINT}>One list for chat and tasks. The order decides who answers first.</p>
        </header>

        {keyStorageMissing && (
          <p role="status" className="text-[13px] text-warn">
            API keys can&apos;t be stored yet: <code>PROVIDER_ENCRYPTION_KEY</code> is not set on the Convex deployment.
            Run <code>npx convex env set PROVIDER_ENCRYPTION_KEY &quot;$(openssl rand -base64 32)&quot;</code> and put the
            same value in <code>.env</code> for the worker. Local servers without a key (Ollama, LM Studio) work without it.
          </p>
        )}

        {/* 1. Mode */}
        <section className="grid gap-2" aria-labelledby="llm-mode">
          <div className="flex items-center justify-between gap-3">
            <h3 id="llm-mode" className="text-[13px] font-medium text-ink-2">Mode</h3>
            <Segmented
              label="Model selection mode"
              value={selectionMode}
              onChange={(mode) => void chooseSelectionMode(mode)}
              options={[
                { value: "fallback", label: "Fallback" },
                { value: "round_robin", label: "Round robin" },
              ]}
            />
          </div>
          <p className={HINT}>
            {selectionMode === "fallback"
              ? "Every call starts at the top of the list and moves down only when a model fails or answers empty."
              : "Calls take turns starting at each model in the list. A failing model still hands over to the next one."}
          </p>
        </section>

        {/* 2. Providers */}
        <section className="grid gap-2" aria-labelledby="llm-providers">
          <div className="flex items-center justify-between gap-3">
            <h3 id="llm-providers" className="text-[13px] font-medium text-ink-2">Providers</h3>
            {!providerFormOpen && (
              <button type="button" onClick={openAddProvider} className={GHOST}>
                <Plus size={13} /> Add
              </button>
            )}
          </div>

          {providerFormOpen && (
            <form onSubmit={saveProvider} className="grid gap-3 border-y border-line py-4">
              <p className="text-[13px] font-medium text-ink">{editingId ? "Edit provider" : "Add provider"}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={LABEL}>
                  Provider
                  <select value={form.presetId} onChange={(e) => pickPreset(e.target.value)} className={FIELD}>
                    {LLM_PROVIDER_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </label>
                <label className={LABEL}>
                  Name
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={FIELD} />
                </label>
                <label className={`${LABEL} sm:col-span-2`}>
                  API key
                  <input
                    type="password"
                    autoComplete="off"
                    value={form.apiKey}
                    onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                    placeholder={
                      editingId
                        ? "Leave empty to keep the stored key"
                        : preset?.needsKey
                          ? "Paste your key"
                          : "Optional for a local server"
                    }
                    className={FIELD}
                  />
                  {preset?.apiKeyUrl && (
                    <a href={preset.apiKeyUrl} target="_blank" rel="noreferrer" className="text-[12px] text-ink-2 underline underline-offset-2 hover:text-ink">
                      Get a {preset.label} key
                    </a>
                  )}
                </label>
              </div>
              <details className="group">
                <summary className="cursor-pointer text-[12.5px] text-ink-3 hover:text-ink">Advanced</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className={`${LABEL} sm:col-span-2`}>
                    Base URL
                    <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://…/v1" className={FIELD} />
                  </label>
                  <label className={LABEL}>
                    Wire format
                    <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} className={FIELD}>
                      <option value="anthropic">Anthropic Messages</option>
                      <option value="openai">OpenAI</option>
                      <option value="openai-compatible">OpenAI-compatible</option>
                    </select>
                  </label>
                  <label className={LABEL}>
                    Key env var (when no key is stored)
                    <input value={form.apiKeyEnv} onChange={(e) => setForm({ ...form, apiKeyEnv: e.target.value })} className={FIELD} />
                  </label>
                  {showWeightPatterns ? (
                    <>
                      <label className={LABEL}>
                        Weight (legacy load balance)
                        <input type="number" value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} className={FIELD} />
                      </label>
                      <label className={LABEL}>
                        Model patterns (comma-separated)
                        <input value={form.modelPatterns} onChange={(e) => setForm({ ...form, modelPatterns: e.target.value })} placeholder="claude-*, gpt-4*" className={FIELD} />
                      </label>
                    </>
                  ) : (
                    <button type="button" onClick={() => setShowWeightPatterns(true)} className="justify-self-start text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink">
                      Show weight and model patterns
                    </button>
                  )}
                  <label className="flex items-center gap-2 text-[13px] text-ink-2 sm:col-span-2">
                    <input type="checkbox" checked={form.isEnabled} onChange={(e) => setForm({ ...form, isEnabled: e.target.checked })} />
                    Enabled (its models are used)
                  </label>
                </div>
              </details>
              {providerError && <p role="alert" className={ERROR_TEXT}>{providerError}</p>}
              <div className="flex items-center gap-2">
                <button type="submit" disabled={providerSaving} className={PRIMARY}>
                  {providerSaving ? "Checking the key…" : editingId ? "Save" : "Check key and add"}
                </button>
                <button type="button" onClick={closeProviderForm} className={GHOST}>Cancel</button>
              </div>
            </form>
          )}

          {/* Plan 038: OpenCode, a special row (the CLI on the worker, no URL, no key). */}
          <div className="grid gap-1" aria-label="OpenCode provider">
            <div className="flex items-center gap-3 border-y border-line py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] text-ink">
                  OpenCode
                  {opencode && !opencode.enabled && (
                    <span className="ml-2 text-[12px] text-ink-3">{opencode.configured ? "disabled" : "not added"}</span>
                  )}
                </p>
                <p className={`truncate text-[12px] ${opencodeLine.kind === "missing" ? "text-warn" : "text-ink-3"}`} title={opencodeLine.text}>
                  {opencodeLine.text}
                  {opencode && opencode.checkedAt > 0 && ` · checked ${relativeTime(opencode.checkedAt)}`}
                  {opencode?.pendingCheck && " · checking…"}
                </p>
              </div>
              <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
                <input
                  type="checkbox"
                  checked={opencode?.enabled ?? false}
                  disabled={!opencode || opencodeBusy}
                  onChange={(e) => void setOpencodeEnabled(e.target.checked)}
                  aria-label="Enable OpenCode"
                />
                Enabled
              </label>
              <RowMenu
                label="OpenCode actions"
                items={[
                  {
                    label: opencode?.pendingTest && opencodeTestKey === "p:opencode" ? "Testing…" : "Test",
                    onClick: () => void testOpencode("p:opencode"),
                  },
                  { label: "Check again", onClick: () => void checkOpencodeAgain() },
                ]}
              />
            </div>
            {opencodeLine.kind === "missing" && (
              <p className={HINT}>
                Install it on the worker machine with <code>{OPENCODE_INSTALL_COMMAND}</code>, then press Check again.
              </p>
            )}
            {opencode && !opencode.configured && opencode.legacy?.runtime === "opencode" && (
              <p className={HINT}>
                Enabling it replaces the old OpenCode runtime setting
                {opencode.legacy.model ? `; ${opencode.legacy.model} becomes the first model in the list` : ""}.
              </p>
            )}
            {opencodeTestKey === "p:opencode" && !opencode?.pendingTest && opencodeTest && (
              <p className={opencodeTest.ok ? HINT : ERROR_TEXT}>
                {opencodeTest.ok
                  ? `OK · ${opencodeTest.model ?? "OpenCode default model"} · ${opencodeTest.latencyMs} ms`
                  : `Failed · ${opencodeTest.model ?? "OpenCode"} · ${opencodeTest.error ?? "error"}`}
              </p>
            )}
          </div>

          {sortedProviders === undefined && <p className={HINT}>Loading…</p>}
          {sortedProviders && sortedProviders.length === 0 && !providerFormOpen && (
            <p className={HINT}>
              No providers yet. Add one with its API key. Until then, Fhara uses the LLM_* variables from the server
              environment, if they are set.
            </p>
          )}
          {sortedProviders && sortedProviders.length > 0 && (
            <ul className="divide-y divide-line border-y border-line">
              {sortedProviders.map((p) => {
                const known = findPreset(p.presetId) ?? guessPreset(p);
                const count = (models ?? []).filter((m) => m.providerId === p._id).length;
                const health = healthStats?.snapshots?.[p.name];
                const circuitOpen = health?.circuitOpenUntil != null && health.circuitOpenUntil > Date.now();
                const test = tests[`p:${p._id}`];
                const keyStatus = p.apiKeyConfigured
                  ? "key stored"
                  : known.needsKey
                    ? `key from env ${p.apiKeyEnv}, if set`
                    : "no key";
                return (
                  <li key={p._id} className="grid gap-1 py-2">
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px] text-ink">
                          {p.name}
                          {p.isEnabled === false && <span className="ml-2 text-[12px] text-ink-3">disabled</span>}
                        </p>
                        <p className="truncate text-[12px] text-ink-3">
                          {known.label} · {hostOf(p.baseUrl)} · {keyStatus} · {count} model{count === 1 ? "" : "s"}
                          {circuitOpen && ` · paused until ${new Date(health!.circuitOpenUntil!).toLocaleTimeString()}`}
                        </p>
                      </div>
                      <RowMenu
                        label={`${p.name} actions`}
                        items={[
                          {
                            label: test === "running" ? "Testing…" : "Test",
                            onClick: () => void runTest(`p:${p._id}`, p._id),
                          },
                          { label: "Edit", onClick: () => openEditProvider(p) },
                          { label: "Remove", onClick: () => askRemoveProvider(p), danger: true },
                        ]}
                      />
                    </div>
                    {test && test !== "running" && (
                      <p className={test.ok ? HINT : ERROR_TEXT}>{testLine(test)}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 3. Models (the order) */}
        <section className="grid gap-2" aria-labelledby="llm-models">
          <div className="flex items-center justify-between gap-3">
            <h3 id="llm-models" className="text-[13px] font-medium text-ink-2">Models</h3>
            {!modelFormOpen && canAddModel && (
              <button type="button" onClick={openAddModel} className={GHOST}>
                <Plus size={13} /> Add
              </button>
            )}
          </div>
          <p className={HINT}>
            {selectionMode === "fallback"
              ? "Top to bottom is the fallback order: the first model answers, the next one takes over when it fails."
              : "Every enabled model takes turns. The order sets which one starts first and who takes over on a failure."}
          </p>
          {hasOpencodeEntries && <p className={HINT}>Chat uses the API models; OpenCode entries run tasks only.</p>}

          {modelFormOpen && (
            <form onSubmit={saveModel} className="grid gap-3 border-y border-line py-4">
              <p className="text-[13px] font-medium text-ink">Add model</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={LABEL}>
                  Provider
                  <select
                    value={modelForm.providerId}
                    onChange={(e) => {
                      setModelForm({ ...modelForm, providerId: e.target.value, modelId: "" });
                      setModelOptionsError("");
                    }}
                    className={FIELD}
                  >
                    {(sortedProviders ?? []).map((p) => (
                      <option key={p._id} value={p._id}>{p.name}</option>
                    ))}
                    {opencodeRowId && <option value={opencodeRowId}>OpenCode (tasks only)</option>}
                  </select>
                </label>
                <label className={LABEL}>
                  Model
                  <div className="relative">
                    <input
                      value={modelForm.modelId}
                      onChange={(e) => setModelForm({ ...modelForm, modelId: e.target.value })}
                      onFocus={() => setModelMenuOpen(true)}
                      placeholder={
                        addingOpencode
                          ? "provider/model"
                          : modelOptionsLoading
                            ? "Loading models…"
                            : options.length > 0
                              ? "Pick or type a model id"
                              : modelPreset?.modelHint ?? "Model id"
                      }
                      className={FIELD}
                    />
                    {modelMenuOpen && options.length > 0 && (
                      <div className={popoverClass}>
                        <ul className="max-h-52 overflow-y-auto">
                          {options
                            .filter((id) => id.toLowerCase().includes(modelForm.modelId.toLowerCase()))
                            .slice(0, 20)
                            .map((id) => (
                              <li key={id}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setModelForm({ ...modelForm, modelId: id });
                                    setModelMenuOpen(false);
                                  }}
                                  className="w-full rounded-md px-2 py-1 text-left text-[13px] hover:bg-hover"
                                >
                                  {id}
                                </button>
                              </li>
                            ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </label>
              </div>
              {addingOpencode ? (
                <p className={HINT}>
                  {options.length > 0
                    ? `${options.length} models the worker's OpenCode CLI can run, or type a provider/model id.`
                    : "The worker has not listed OpenCode models yet. Type a provider/model id, or press Check again."}
                </p>
              ) : (
                options.length > 0 && <p className={HINT}>{options.length} models available from this provider.</p>
              )}
              <details>
                <summary className="cursor-pointer text-[12.5px] text-ink-3 hover:text-ink">Advanced</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className={LABEL}>
                    Display name
                    <input value={modelForm.displayName} onChange={(e) => setModelForm({ ...modelForm, displayName: e.target.value })} className={FIELD} />
                  </label>
                  <label className={LABEL}>
                    Context window (tokens)
                    <input type="number" min="0" value={modelForm.contextWindow} onChange={(e) => setModelForm({ ...modelForm, contextWindow: e.target.value })} className={FIELD} />
                  </label>
                  <label className={LABEL}>
                    Input price / 1k tokens
                    <input type="number" min="0" step="any" value={modelForm.inputPricePer1k} onChange={(e) => setModelForm({ ...modelForm, inputPricePer1k: e.target.value })} className={FIELD} />
                  </label>
                  <label className={LABEL}>
                    Output price / 1k tokens
                    <input type="number" min="0" step="any" value={modelForm.outputPricePer1k} onChange={(e) => setModelForm({ ...modelForm, outputPricePer1k: e.target.value })} className={FIELD} />
                  </label>
                  <label className="flex items-center gap-2 text-[13px] text-ink-2">
                    <input type="checkbox" checked={modelForm.supportsTools} onChange={(e) => setModelForm({ ...modelForm, supportsTools: e.target.checked })} />
                    Supports tools
                  </label>
                  <label className="flex items-center gap-2 text-[13px] text-ink-2">
                    <input type="checkbox" checked={modelForm.supportsReasoning} onChange={(e) => setModelForm({ ...modelForm, supportsReasoning: e.target.checked })} />
                    Supports reasoning
                  </label>
                </div>
              </details>
              {modelOptionsError && <p role="alert" className={ERROR_TEXT}>{modelOptionsError}</p>}
              <div className="flex items-center gap-2">
                <button type="submit" className={PRIMARY}>Add to the list</button>
                <button type="button" onClick={() => setModelFormOpen(false)} className={GHOST}>Done</button>
              </div>
            </form>
          )}

          {models !== undefined && orderedModels.length === 0 && !modelFormOpen && (
            <p className={HINT}>
              {(sortedProviders?.length ?? 0) > 0 ? "No models in the list yet. Add one." : "Add a provider first."}
            </p>
          )}
          {orderedModels.length > 0 && (
            <ol className="divide-y divide-line border-y border-line">
              {orderedModels.map((m, index) => {
                const owner = providerById.get(m.providerId);
                const isOpencode = isOpencodeConnection(owner);
                // Plan 038: an OpenCode entry the worker would skip right now.
                const unavailable = isOpencode && m.isAvailable ? opencodeOff : null;
                const off = !m.isAvailable || owner?.isEnabled === false || unavailable !== null;
                const test = isOpencode
                  ? opencodeTestKey === `m:${m._id}`
                    ? opencode?.pendingTest
                      ? "running"
                      : opencodeTest
                        ? {
                            ok: opencodeTest.ok,
                            connection: "OpenCode",
                            model: opencodeTest.model ?? m.modelId,
                            latencyMs: opencodeTest.latencyMs,
                            detail: opencodeTest.error ?? "OK",
                          }
                        : undefined
                    : undefined
                  : tests[`m:${m._id}`];
                return (
                  <li key={m._id} className="grid gap-1 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="w-4 shrink-0 text-right text-[12px] tabular-nums text-ink-3">{index + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className={`truncate text-[13.5px] ${off ? "text-ink-3" : "text-ink"}`}>
                          {m.displayName || m.modelId}
                        </p>
                        <p className="truncate text-[12px] text-ink-3">
                          {isOpencode ? "OpenCode · tasks only" : owner?.name ?? "Unknown provider"}
                          {m.displayName ? ` · ${m.modelId}` : ""}
                          {!m.isAvailable
                            ? " · disabled"
                            : unavailable
                              ? ` · unavailable (${unavailable})`
                              : owner?.isEnabled === false
                                ? " · provider disabled"
                                : ""}
                        </p>
                      </div>
                      <button type="button" onClick={() => void move(index, -1)} disabled={index === 0} className={ICON} aria-label={`Move ${m.modelId} up`}>
                        <ArrowUp size={14} />
                      </button>
                      <button type="button" onClick={() => void move(index, 1)} disabled={index === orderedModels.length - 1} className={ICON} aria-label={`Move ${m.modelId} down`}>
                        <ArrowDown size={14} />
                      </button>
                      <RowMenu
                        label={`${m.modelId} actions`}
                        items={[
                          {
                            label: test === "running" ? "Testing…" : "Test",
                            onClick: () => void runTest(`m:${m._id}`, m.providerId, m._id),
                          },
                          { label: m.isAvailable ? "Disable" : "Enable", onClick: () => void toggleModel(m) },
                          { label: "Remove", onClick: () => askRemoveModel(m), danger: true },
                        ]}
                      />
                    </div>
                    {test && test !== "running" && (
                      <p className={`pl-6 ${test.ok ? HINT : ERROR_TEXT}`}>{testLine(test)}</p>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
        <RoleOverrideKnob />
      </div>
    </>
  );
}
