/**
 * Model Capability Registry (plan 027). Pure TypeScript, shared by the
 * backend (overrides, probe), the worker (resolver needs filtering) and the
 * web UI (LLM settings). Validators live in contractValidators.ts.
 *
 * Every model id resolves to one full `ModelCapabilities` record, field by
 * field, from the first layer that knows the field:
 *
 *   1. project override   (modelCapabilityOverrides row with projectId)
 *   2. global override    (row without projectId)
 *   3. probe observation  (the last manual capability probe, timestamped)
 *   4. model registry row (llmModels: contextWindow, supportsTools=true, prices)
 *   5. built-in defaults  (BUILTIN_MODEL_CAPABILITIES, by model id glob)
 *   6. unknown defaults   (UNKNOWN_CAPABILITIES — conservative)
 *
 * Layers 1–2 are what the user typed; 3 is observed evidence; 4 is the
 * older registry metadata (supportsTools=false is ignored there because the
 * settings form always writes the checkbox, so false means "never ticked",
 * not "verified no tools"); 5 is our guess for common model ids.
 *
 * Tool calling is three-valued: "native" (OpenAI/Anthropic tool calls),
 * "markup" (the model writes tool calls as text markup such as
 * <longcat_tool_call>…</longcat_tool_call>, which the worker's
 * toolCallMarkup parser handles), or "none". A tool-calling need is
 * satisfied by native or markup.
 */

export const TOOL_CALLING_MODES = ["native", "markup", "none"] as const;
export type ToolCallingMode = (typeof TOOL_CALLING_MODES)[number];

export const STRENGTH_TAGS = ["reasoning", "coding", "summarization", "cheap"] as const;
export type StrengthTag = (typeof STRENGTH_TAGS)[number];

export interface ModelCapabilities {
  structuredOutput: boolean;
  toolCalling: ToolCallingMode;
  vision: boolean;
  maxContextTokens: number;
  supportsStreaming: boolean;
  supportsCancellation: boolean;
  strengths: StrengthTag[];
  /** USD per 1k tokens; null = unknown. */
  costPer1kIn: number | null;
  costPer1kOut: number | null;
}

export type CapabilityField = keyof ModelCapabilities;
export const CAPABILITY_FIELDS: CapabilityField[] = [
  "structuredOutput",
  "toolCalling",
  "vision",
  "maxContextTokens",
  "supportsStreaming",
  "supportsCancellation",
  "strengths",
  "costPer1kIn",
  "costPer1kOut",
];

export type CapabilitySource = "project" | "global" | "probe" | "registry" | "builtin" | "unknown";

/** A partial capability record (override row, probe, built-in entry). */
export type CapabilityPatch = Partial<{
  structuredOutput: boolean;
  toolCalling: ToolCallingMode;
  vision: boolean;
  maxContextTokens: number;
  supportsStreaming: boolean;
  supportsCancellation: boolean;
  strengths: StrengthTag[];
  costPer1kIn: number;
  costPer1kOut: number;
}>;

/** What a manual probe observed against a configured endpoint. */
export interface CapabilityProbeResult {
  at: number;
  connectionName?: string;
  structuredOutput?: boolean;
  toolCalling?: ToolCallingMode;
  /** Short error text per check when the call itself failed (no verdict). */
  errors?: string[];
}

/** One stored override row (global when projectId is absent). */
export interface CapabilityOverrideRow extends CapabilityPatch {
  modelId: string;
  projectId?: string | null;
  probe?: CapabilityProbeResult | null;
}

/** Older registry metadata on llmModels rows. */
export interface RegistryModelFields {
  contextWindow?: number;
  supportsTools?: boolean;
  inputPricePer1k?: number;
  outputPricePer1k?: number;
}

/** Conservative defaults for a model nobody described. */
export const UNKNOWN_CAPABILITIES: ModelCapabilities = {
  structuredOutput: false,
  toolCalling: "none",
  vision: false,
  maxContextTokens: 8192,
  supportsStreaming: false,
  supportsCancellation: false,
  strengths: [],
  costPer1kIn: null,
  costPer1kOut: null,
};

/**
 * Built-in defaults for common model ids. Matched case-insensitively on the
 * full id and on the part after the last "/" (so "openai/gpt-4o" and
 * "gpt-4o" both match "gpt-4o*"). First match wins: list specific patterns
 * before their family. Costs are left out on purpose: prices change, and a
 * stale price is worse than "unknown" for the budget factor.
 */
export const BUILTIN_MODEL_CAPABILITIES: ReadonlyArray<{ pattern: string; caps: CapabilityPatch }> = [
  // The user's "nous" connection serves meituan/longcat: JSON is reliable
  // (planner/decision e2e pass), tool calls arrive as <longcat_tool_call>
  // markup, handled by utils/toolCallMarkup.ts.
  { pattern: "*longcat*", caps: { structuredOutput: true, toolCalling: "markup", vision: false, maxContextTokens: 128_000, supportsStreaming: true, supportsCancellation: true, strengths: ["reasoning", "coding"] } },
  { pattern: "nous", caps: { structuredOutput: true, toolCalling: "markup", vision: false, maxContextTokens: 128_000, supportsStreaming: true, supportsCancellation: true, strengths: ["reasoning", "coding"] } },
  { pattern: "gpt-4o-mini*", caps: { structuredOutput: true, toolCalling: "native", vision: true, maxContextTokens: 128_000, supportsStreaming: true, supportsCancellation: true, strengths: ["summarization", "cheap"] } },
  { pattern: "gpt-4.1-mini*", caps: { structuredOutput: true, toolCalling: "native", vision: true, maxContextTokens: 1_000_000, supportsStreaming: true, supportsCancellation: true, strengths: ["coding", "cheap"] } },
  { pattern: "gpt-4.1*", caps: { structuredOutput: true, toolCalling: "native", vision: true, maxContextTokens: 1_000_000, supportsStreaming: true, supportsCancellation: true, strengths: ["coding"] } },
  { pattern: "gpt-4o*", caps: { structuredOutput: true, toolCalling: "native", vision: true, maxContextTokens: 128_000, supportsStreaming: true, supportsCancellation: true, strengths: ["coding", "summarization"] } },
  { pattern: "gpt-5*mini*", caps: { structuredOutput: true, toolCalling: "native", vision: true, maxContextTokens: 400_000, supportsStreaming: true, supportsCancellation: true, strengths: ["reasoning", "coding", "cheap"] } },
  { pattern: "gpt-5*", caps: { structuredOutput: true, toolCalling: "native", vision: true, maxContextTokens: 400_000, supportsStreaming: true, supportsCancellation: true, strengths: ["reasoning", "coding"] } },
  { pattern: "o[134]*", caps: { structuredOutput: true, toolCalling: "native", vision: true, maxContextTokens: 200_000, supportsStreaming: true, supportsCancellation: true, strengths: ["reasoning"] } },
  { pattern: "claude-*haiku*", caps: { structuredOutput: true, toolCalling: "native", vision: true, maxContextTokens: 200_000, supportsStreaming: true, supportsCancellation: true, strengths: ["summarization", "cheap"] } },
  { pattern: "claude-*", caps: { structuredOutput: true, toolCalling: "native", vision: true, maxContextTokens: 200_000, supportsStreaming: true, supportsCancellation: true, strengths: ["reasoning", "coding"] } },
  { pattern: "gemini-*flash*", caps: { structuredOutput: true, toolCalling: "native", vision: true, maxContextTokens: 1_000_000, supportsStreaming: true, supportsCancellation: true, strengths: ["summarization", "cheap"] } },
  { pattern: "gemini-*", caps: { structuredOutput: true, toolCalling: "native", vision: true, maxContextTokens: 1_000_000, supportsStreaming: true, supportsCancellation: true, strengths: ["reasoning", "coding"] } },
  { pattern: "deepseek-reasoner*", caps: { structuredOutput: true, toolCalling: "none", vision: false, maxContextTokens: 64_000, supportsStreaming: true, supportsCancellation: true, strengths: ["reasoning"] } },
  { pattern: "deepseek-r1*", caps: { structuredOutput: true, toolCalling: "none", vision: false, maxContextTokens: 64_000, supportsStreaming: true, supportsCancellation: true, strengths: ["reasoning"] } },
  { pattern: "deepseek-*", caps: { structuredOutput: true, toolCalling: "native", vision: false, maxContextTokens: 64_000, supportsStreaming: true, supportsCancellation: true, strengths: ["coding", "cheap"] } },
  { pattern: "qwen*", caps: { structuredOutput: true, toolCalling: "native", vision: false, maxContextTokens: 32_000, supportsStreaming: true, supportsCancellation: true, strengths: ["coding"] } },
  { pattern: "*llama-3*", caps: { structuredOutput: true, toolCalling: "native", vision: false, maxContextTokens: 128_000, supportsStreaming: true, supportsCancellation: true, strengths: ["cheap"] } },
  { pattern: "mistral-*", caps: { structuredOutput: true, toolCalling: "native", vision: false, maxContextTokens: 32_000, supportsStreaming: true, supportsCancellation: true, strengths: [] } },
];

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

/** The built-in entry for a model id, if any (full id first, then the tail after "/"). */
export function builtinCapabilitiesFor(modelId: string): CapabilityPatch | null {
  const id = modelId.trim();
  const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  for (const entry of BUILTIN_MODEL_CAPABILITIES) {
    if (globMatch(entry.pattern, id) || globMatch(entry.pattern, tail)) return entry.caps;
  }
  return null;
}

/** Keep only well-formed fields of a stored/typed patch. */
export function sanitizeCapabilityPatch(value: unknown): CapabilityPatch {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const out: CapabilityPatch = {};
  for (const key of ["structuredOutput", "vision", "supportsStreaming", "supportsCancellation"] as const) {
    if (typeof raw[key] === "boolean") out[key] = raw[key] as boolean;
  }
  if (typeof raw.toolCalling === "string" && (TOOL_CALLING_MODES as readonly string[]).includes(raw.toolCalling)) {
    out.toolCalling = raw.toolCalling as ToolCallingMode;
  }
  if (typeof raw.maxContextTokens === "number" && Number.isFinite(raw.maxContextTokens) && raw.maxContextTokens > 0) {
    out.maxContextTokens = Math.floor(raw.maxContextTokens);
  }
  for (const key of ["costPer1kIn", "costPer1kOut"] as const) {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key]) && (raw[key] as number) >= 0) out[key] = raw[key] as number;
  }
  if (Array.isArray(raw.strengths)) {
    out.strengths = raw.strengths.filter((tag): tag is StrengthTag => (STRENGTH_TAGS as readonly string[]).includes(tag as string));
  }
  return out;
}

function registryPatch(row: RegistryModelFields | undefined, builtin: CapabilityPatch | null): CapabilityPatch {
  if (!row) return {};
  const out: CapabilityPatch = {};
  if (typeof row.contextWindow === "number" && row.contextWindow > 0) out.maxContextTokens = row.contextWindow;
  // Only a ticked box is evidence (the form always writes the checkbox).
  // Keep the built-in markup mode when the model is a markup caller.
  if (row.supportsTools === true) out.toolCalling = builtin?.toolCalling === "markup" ? "markup" : "native";
  if (typeof row.inputPricePer1k === "number") out.costPer1kIn = row.inputPricePer1k;
  if (typeof row.outputPricePer1k === "number") out.costPer1kOut = row.outputPricePer1k;
  return out;
}

function probePatch(probe: CapabilityProbeResult | null | undefined): CapabilityPatch {
  if (!probe) return {};
  const out: CapabilityPatch = {};
  if (typeof probe.structuredOutput === "boolean") out.structuredOutput = probe.structuredOutput;
  if (probe.toolCalling && (TOOL_CALLING_MODES as readonly string[]).includes(probe.toolCalling)) out.toolCalling = probe.toolCalling;
  return out;
}

export interface ResolvedModelCapabilities {
  modelId: string;
  capabilities: ModelCapabilities;
  /** Which layer decided each field. */
  sources: Record<CapabilityField, CapabilitySource>;
  /** Last probe for this model (project row first, then global), if any. */
  probe: CapabilityProbeResult | null;
}

/**
 * Resolve one model id. `overrides` may hold rows for any model and any
 * project; only rows for this model and (this project | global) apply.
 */
export function resolveModelCapabilities(
  modelId: string,
  input: {
    overrides?: CapabilityOverrideRow[];
    projectId?: string | null;
    registry?: RegistryModelFields;
  } = {}
): ResolvedModelCapabilities {
  const rows = (input.overrides ?? []).filter((row) => row.modelId === modelId);
  const projectRow = input.projectId ? rows.find((row) => row.projectId && row.projectId === input.projectId) : undefined;
  const globalRow = rows.find((row) => !row.projectId);
  const builtin = builtinCapabilitiesFor(modelId);
  const probe = projectRow?.probe ?? globalRow?.probe ?? null;
  const layers: Array<[CapabilitySource, CapabilityPatch]> = [
    ["project", sanitizeCapabilityPatch(projectRow)],
    ["global", sanitizeCapabilityPatch(globalRow)],
    ["probe", probePatch(probe)],
    ["registry", registryPatch(input.registry, builtin)],
    ["builtin", builtin ?? {}],
  ];
  const capabilities = { ...UNKNOWN_CAPABILITIES, strengths: [...UNKNOWN_CAPABILITIES.strengths] } as ModelCapabilities;
  const sources = {} as Record<CapabilityField, CapabilitySource>;
  for (const field of CAPABILITY_FIELDS) {
    sources[field] = "unknown";
    for (const [source, patch] of layers) {
      const value = patch[field];
      if (value !== undefined) {
        (capabilities as unknown as Record<string, unknown>)[field] = Array.isArray(value) ? [...value] : value;
        sources[field] = source;
        break;
      }
    }
  }
  return { modelId, capabilities, sources, probe };
}

// ─── Needs ──────────────────────────────────────────────────────────────

/** What one LLM call site needs from its model. */
export interface CapabilityNeeds {
  structuredOutput?: boolean;
  /** Satisfied by native or markup tool calling. */
  toolCalling?: boolean;
  vision?: boolean;
  /** Estimated prompt + reserved completion tokens. */
  minContextTokens?: number;
}

export function hasNeeds(needs: CapabilityNeeds | undefined): boolean {
  return Boolean(needs && (needs.structuredOutput || needs.toolCalling || needs.vision || (needs.minContextTokens ?? 0) > 0));
}

/** The needs a model misses (empty = satisfied). */
export function missingNeeds(capabilities: ModelCapabilities, needs: CapabilityNeeds | undefined): string[] {
  if (!needs) return [];
  const missing: string[] = [];
  if (needs.structuredOutput && !capabilities.structuredOutput) missing.push("structuredOutput");
  if (needs.toolCalling && capabilities.toolCalling === "none") missing.push("toolCalling");
  if (needs.vision && !capabilities.vision) missing.push("vision");
  if (needs.minContextTokens && needs.minContextTokens > capabilities.maxContextTokens) {
    missing.push(`context ${needs.minContextTokens} > ${capabilities.maxContextTokens}`);
  }
  return missing;
}

export function describeNeeds(needs: CapabilityNeeds | undefined): string {
  if (!hasNeeds(needs)) return "no capability needs";
  const parts: string[] = [];
  if (needs!.structuredOutput) parts.push("structured output");
  if (needs!.toolCalling) parts.push("tool calling");
  if (needs!.vision) parts.push("vision");
  if (needs!.minContextTokens) parts.push(`≥${needs!.minContextTokens} context tokens`);
  return parts.join(", ");
}

/** Rough token estimate (chars/4), the same rule as estimated usage rows. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Room left for the completion when sizing a context need. */
export const COMPLETION_RESERVE_TOKENS = 4096;

/** Needs of the call sites, in one place so the resolver and tests agree. */
export const CALL_SITE_NEEDS = {
  planner: (promptChars: number): CapabilityNeeds => ({ structuredOutput: true, minContextTokens: Math.ceil(promptChars / 4) + COMPLETION_RESERVE_TOKENS }),
  decision: (promptChars: number): CapabilityNeeds => ({ structuredOutput: true, minContextTokens: Math.ceil(promptChars / 4) + COMPLETION_RESERVE_TOKENS }),
  /**
   * Executor: tool calling when the subtask runs with tools (code change /
   * analysis on the API runtime); vision when QA compares screenshots.
   * Context is sized from the task + subtask text plus the reserve —
   * repository context is added later and capped by the executor.
   */
  executor: (input: { kind: string; usesTools: boolean; visualQa: boolean; promptChars: number }): CapabilityNeeds => ({
    ...(input.usesTools ? { toolCalling: true } : {}),
    ...(input.kind === "qa" && input.visualQa ? { vision: true } : {}),
    minContextTokens: Math.ceil(input.promptChars / 4) + COMPLETION_RESERVE_TOKENS,
  }),
};
