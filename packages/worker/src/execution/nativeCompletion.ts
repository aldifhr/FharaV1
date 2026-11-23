import type { LLMCallOptions, LLMMessage, LLMProvider, LLMResult } from "@/llm";
import { runChatLlm, type ChatLlmSpawnResult } from "@/tools/chatLlm";

/**
 * A native CLI connection presented as an ordinary LLMProvider (plan 074).
 *
 * API-path callers (setup default config, planner, decision, memory, commit)
 * resolve through the same ordered model list as subtasks. When the global
 * selection is a native CLI model, those callers need a completion-style
 * provider too: this adapter runs `opencode run --pure` with the prompt on
 * stdin and returns the CLI's text verbatim so the callers' existing JSON
 * parsers keep working. No HTTP credential is involved.
 */
export interface NativeCompletionOptions {
  command?: string;
  timeoutMs?: number;
  spawnImpl?: (command: string, argv: string[], stdin: string) => Promise<ChatLlmSpawnResult>;
}

function completionPrompt(messages: LLMMessage[]): string {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
    .join("\n\n");
  return [system, turns].filter(Boolean).join("\n\n");
}

export function nativeCompletionProvider(model: string, opts: NativeCompletionOptions = {}): LLMProvider {
  const selected = model.trim();
  return {
    async complete(messages: LLMMessage[], overrideModel?: string, callOpts?: LLMCallOptions): Promise<LLMResult> {
      const used = (overrideModel ?? selected).trim();
      if (!used) throw new Error("No global model was selected for the native completion call.");
      const ran = await runChatLlm(
        { model: used },
        {
          command: opts.command,
          timeoutMs: callOpts?.timeoutMs ?? opts.timeoutMs,
          signal: callOpts?.signal,
          prompt: completionPrompt(messages),
          ...(opts.spawnImpl ? { spawnImpl: opts.spawnImpl } : {}),
        }
      );
      if (!ran.ok) throw new Error(ran.text);
      return { content: ran.text };
    },
  };
}
