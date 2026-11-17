import type { EventSink } from "@/types/events";
import {
  isNativeProviderAvailable,
  runNativeProvider,
  type NativeLlmConfig,
  type NativeRunResult,
  type SpawnImpl,
} from "./nativeProvider";
import { codexCommand, isCodexAvailable, runCodexProvider, type NativeProviderDriver } from "./codexProvider";
import { acpCommand, acpArgs, isAcpAvailable, runAcpProvider } from "./acpProvider";
import type { OpencodePolicy } from "./opencodePolicy";

/**
 * Plan 057: one seam for "run this subtask on a provider-native CLI".
 *
 * The caller (agentExecutor) keeps the credential, policy and staging
 * decisions; this module only picks the driver, so adding a CLI does not
 * grow the executor again. OpenCode needs Fhara's resolved LLM config and
 * permission policy; Codex uses the operator's own login and takes neither;
 * ACP (plan 058 step 3) speaks the Agent Client Protocol to an ACP agent
 * with Fhara's deny-by-default policy mapped onto its permission requests.
 */
export interface NativeRunRequest {
  driver?: NativeProviderDriver;
  workspacePath: string;
  prompt: string;
  /** OpenCode binary override (ORCHESTRATOR_NATIVE_PROVIDER_COMMAND). */
  opencodeCommand?: string;
  /** Codex binary override (ORCHESTRATOR_CODEX_COMMAND). */
  codexCommand?: string;
  /** ACP agent command override (ORCHESTRATOR_ACP_COMMAND). */
  acpCommand?: string;
  /** OpenCode `provider/model`; ignored by the codex driver. */
  model?: string;
  llm?: NativeLlmConfig;
  policy?: OpencodePolicy;
  /** Whether the run may mutate the workspace (drives ACP write capabilities). */
  mutating?: boolean;
  timeoutMs?: number;
  spawnImpl?: SpawnImpl;
  signal?: AbortSignal;
  onEvent?: EventSink;
  onChunk?: (delta: string) => Promise<void>;
  onMessage?: (text: string) => Promise<void>;
}

export interface NativeDriverAvailability {
  available: boolean;
  provider: string;
  driver: NativeProviderDriver;
}

/** Probe the selected CLI once; the executor falls back to the API path when it is missing. */
export async function nativeDriverAvailability(input: {
  nativeDriver?: NativeProviderDriver;
  nativeProviderCommand?: string;
  codexCommand?: string;
  acpCommand?: string;
  nativeSpawnImpl?: SpawnImpl;
}): Promise<NativeDriverAvailability> {
  const driver = input.nativeDriver ?? "opencode";
  if (driver === "codex") {
    const provider = input.codexCommand ?? codexCommand();
    return { available: await isCodexAvailable(provider, input.nativeSpawnImpl), provider, driver };
  }
  if (driver === "acp") {
    const provider = input.acpCommand ?? acpCommand();
    return { available: await isAcpAvailable(provider), provider, driver };
  }
  const provider = input.nativeProviderCommand ?? "native-provider";
  return { available: await isNativeProviderAvailable(input.nativeProviderCommand), provider, driver };
}

export async function runNativeDriver(input: NativeRunRequest): Promise<NativeRunResult> {
  const driver = input.driver ?? "opencode";
  if (driver === "codex") {
    return runCodexProvider({
      workspacePath: input.workspacePath,
      prompt: input.prompt,
      command: input.codexCommand,
      timeoutMs: input.timeoutMs,
      spawnImpl: input.spawnImpl,
      signal: input.signal,
      onEvent: input.onEvent,
      onChunk: input.onChunk,
      onMessage: input.onMessage,
    });
  }
  if (driver === "acp") {
    return runAcpProvider({
      workspacePath: input.workspacePath,
      prompt: input.prompt,
      command: input.acpCommand ?? acpCommand(),
      args: acpArgs(),
      policy: input.policy,
      mutating: input.mutating,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      onEvent: input.onEvent,
      onChunk: input.onChunk,
      onMessage: input.onMessage,
    });
  }
  return runNativeProvider({
    workspacePath: input.workspacePath,
    prompt: input.prompt,
    command: input.opencodeCommand,
    model: input.model,
    llm: input.llm,
    policy: input.policy,
    timeoutMs: input.timeoutMs,
    spawnImpl: input.spawnImpl,
    signal: input.signal,
    onEvent: input.onEvent,
    onChunk: input.onChunk,
    onMessage: input.onMessage,
  });
}
