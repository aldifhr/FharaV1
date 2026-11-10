/**
 * Pure helpers for Settings → LLM & Models (unit-tested in
 * tests/unit/llmModelList.test.mjs). No imports, so node:test can load
 * this file directly.
 */

/** `ids` with the item at `index` moved by `delta` (−1 up, +1 down). Out of range = unchanged copy. */
export function moveItem<T>(ids: readonly T[], index: number, delta: number): T[] {
  const target = index + delta;
  const next = [...ids];
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return next;
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

/** Same members in the same order. */
export function sameOrder<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The order to show: a pending local order while it still names exactly
 * the server's rows (a reorder in flight), else the server order.
 */
export function effectiveOrder(serverIds: readonly string[], pending: readonly string[] | null): string[] {
  if (!pending) return [...serverIds];
  const server = new Set(serverIds);
  if (pending.length !== server.size || pending.some((id) => !server.has(id))) return [...serverIds];
  return [...pending];
}

interface PresetLike {
  id: string;
  label: string;
  provider: string;
  baseUrl: string;
  apiKeyEnv: string;
  needsKey: boolean;
}

export interface ProviderFormState {
  presetId: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  provider: string;
  apiKeyEnv: string;
  weight: string;
  modelPatterns: string;
  isEnabled: boolean;
}

/** Form defaults for a preset: the preset fills everything but the key. */
export function formForPreset(preset: PresetLike, previous?: Partial<ProviderFormState>): ProviderFormState {
  return {
    presetId: preset.id,
    name: preset.label,
    apiKey: previous?.apiKey ?? "",
    baseUrl: preset.baseUrl,
    provider: preset.provider,
    apiKeyEnv: preset.apiKeyEnv,
    weight: "100",
    modelPatterns: "",
    isEnabled: true,
  };
}

/** Why the form cannot be saved yet, or null when it can. */
export function providerFormError(
  form: ProviderFormState,
  preset: PresetLike | undefined,
  editing: boolean
): string | null {
  if (!form.name.trim()) return "Give the provider a name.";
  if (!/^https?:\/\//i.test(form.baseUrl.trim())) return "Set the base URL under Advanced (http or https).";
  if (!editing && preset?.needsKey && !form.apiKey.trim()) return "Paste the API key.";
  return null;
}

/** Fields sent to the admin route for create/update (never more). */
export function providerPayload(form: ProviderFormState): Record<string, unknown> {
  const patterns = form.modelPatterns
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    name: form.name.trim(),
    provider: form.provider,
    baseUrl: form.baseUrl.trim(),
    apiKeyEnv: form.apiKeyEnv.trim() || "LLM_API_KEY",
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    weight: Number(form.weight) || 100,
    modelPatterns: patterns,
    isEnabled: form.isEnabled,
    presetId: form.presetId,
  };
}

/** "api.anthropic.com" out of a base URL (falls back to the raw text). */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Plan 038: what the Settings row knows about the OpenCode CLI. */
export interface OpencodeStatusLike {
  configured: boolean;
  enabled: boolean;
  workerOnline: boolean;
  installed: boolean | null;
  version: string | null;
  path: string | null;
  error: string | null;
}

/**
 * The OpenCode row's status line: "Detected v<x> at <path>", "Not
 * installed", "Worker offline" or "Not checked yet". A worker that is
 * offline wins: its last report may be stale.
 */
export function opencodeStatusLine(status: OpencodeStatusLike | undefined): {
  kind: "detected" | "missing" | "offline" | "unknown";
  text: string;
} {
  if (!status) return { kind: "unknown", text: "Checking…" };
  if (!status.workerOnline) {
    const last =
      status.installed === true
        ? ` (last seen: v${status.version ?? "?"}${status.path ? ` at ${status.path}` : ""})`
        : "";
    return { kind: "offline", text: `Worker offline${last}` };
  }
  if (status.installed === null) return { kind: "unknown", text: "Not checked yet" };
  if (!status.installed) return { kind: "missing", text: `Not installed${status.error ? ` · ${status.error}` : ""}` };
  const where = status.path ? ` at ${status.path}` : "";
  const version = status.version ? ` v${status.version}` : "";
  return {
    kind: "detected",
    text: `Detected${version}${where}${status.error && !status.version ? ` · ${status.error}` : ""}`,
  };
}

/**
 * Why an OpenCode entry of the list cannot run now, or null when it can
 * (as far as Settings can tell; the worker also refuses without worktree
 * isolation and says so in the event log).
 */
export function opencodeUnavailableReason(status: OpencodeStatusLike | undefined): string | null {
  if (!status) return null;
  if (!status.configured || !status.enabled) return "OpenCode disabled";
  if (!status.workerOnline) return "worker offline";
  if (status.installed === false) return "OpenCode not installed";
  if (status.installed === null) return "OpenCode not checked yet";
  return null;
}
