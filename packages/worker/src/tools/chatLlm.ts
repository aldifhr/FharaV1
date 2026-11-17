import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import { wenv } from "@fhara/config/worker";

/**
 * FharaV2-style model selection for chat. The worker owns the local CLI, so it
 * reads settings.json and runs `opencode run` with the composed prompt on
 * stdin. No credential is stored in the settings file: OpenCode uses its own
 * CLI auth. Only the model string crosses the queue.
 */

const DEFAULT_SETTINGS_FILE = path.resolve(process.cwd(), "../../settings.json");

export type ChatLlmArgs = {
  system?: string;
  messages?: Array<{ role: string; content: string }>;
  model?: string;
};

export type ChatLlmResult = { ok: boolean; text: string };

/**
 * A model id is interpolated into a CLI argv that runs with `shell: true` on
 * Windows. Only allow the characters real model ids use, so a value from
 * settings.json or the picker can never become a shell metacharacter.
 */
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const MAX_MODEL_ID_LENGTH = 200;

export function isSafeChatModel(model: string): boolean {
  return model.length > 0 && model.length <= MAX_MODEL_ID_LENGTH && SAFE_MODEL_ID.test(model);
}

export function chatSettingsPath(): string {
  return String(wenv("FHARA_SETTINGS_PATH") ?? "").trim() || DEFAULT_SETTINGS_FILE;
}

export async function readChatModelFromSettings(filePath = chatSettingsPath()): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const json = JSON.parse(raw) as { defaultModelSelection?: { model?: string }; model?: string };
    return String(json?.defaultModelSelection?.model ?? json?.model ?? "").trim() || null;
  } catch {
    return null;
  }
}

export function composeChatPrompt(system: string, messages: Array<{ role: string; content: string }>): string {
  const turns = messages
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
    .join("\n\n");
  return [
    "Answer the user's LATEST message. The conversation below is context only.",
    "## Instructions",
    system,
    "## Conversation",
    turns,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 120_000);
}

export type ChatLlmSpawnResult = { stdout: string; stderr: string; code: number | null };

async function spawnOpenCode(
  command: string,
  argv: string[],
  prompt: string,
  timeoutMs: number,
  spawnImpl?: (command: string, argv: string[], stdin: string) => Promise<ChatLlmSpawnResult>
): Promise<ChatLlmSpawnResult> {
  if (spawnImpl) return await spawnImpl(command, argv, prompt);
  return await new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd: process.cwd(),
      env: buildChildEnv(),
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`OpenCode chat call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    // The child can exit before we hand over the prompt (bad model, CLI error).
    // Without this listener the resulting EPIPE is an unhandled 'error' event.
    child.stdin.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export async function runChatLlm(
  args: ChatLlmArgs,
  opts: { command?: string; timeoutMs?: number; spawnImpl?: (command: string, argv: string[], stdin: string) => Promise<ChatLlmSpawnResult> } = {}
): Promise<ChatLlmResult> {
  const model = String(args.model ?? "").trim() || (await readChatModelFromSettings());
  if (!model) return { ok: false, text: "No model configured in settings.json (defaultModelSelection.model)." };
  if (!isSafeChatModel(model)) return { ok: false, text: "Invalid chat model id: only letters, digits, . _ : @ / - are allowed." };
  const prompt = composeChatPrompt(String(args.system ?? ""), Array.isArray(args.messages) ? args.messages : []);
  const command = String(opts.command ?? wenv("ORCHESTRATOR_NATIVE_PROVIDER_COMMAND") ?? "opencode").trim() || "opencode";
  const timeoutMs = Math.max(5_000, Number(opts.timeoutMs ?? wenv("FHARA_CHAT_LLM_TIMEOUT_MS") ?? 120_000));
  try {
    const ran = await spawnOpenCode(command, ["run", "-m", model, "--pure"], prompt, timeoutMs, opts.spawnImpl);
    const text = String(ran.stdout ?? "").trim();
    if (ran.code !== 0 || !text) {
      return { ok: false, text: `OpenCode chat call failed (${model}, exit ${ran.code}): ${String(ran.stderr ?? "").slice(-400)}` };
    }
    return { ok: true, text };
  } catch (error) {
    return { ok: false, text: `OpenCode chat call failed (${model}): ${error instanceof Error ? error.message : String(error)}` };
  }
}
