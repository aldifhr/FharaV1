/**
 * Integrations: turn one MCP server row into a spawnable command.
 *
 * - `{workspace}` in args → the run's workspace path.
 * - `{env:KEY}` in args → the decrypted secret value (e.g. the Postgres
 *   DATABASE_URL, which the reference server takes as an argument).
 * - The row's env (`envCiphertext`) is decrypted HERE, at spawn time, with
 *   the worker's PROVIDER_ENCRYPTION_KEY, and handed to the child only.
 *
 * `secretValues` lets callers redact those values from any error or stderr
 * text before it is reported back to Convex.
 */

import { decryptApiKey } from "@/llm/crypto";
import type { McpServerConfig } from "./types";

export interface McpSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  secretValues: string[];
}

const WORKSPACE_TOKEN = "{workspace}";
const ENV_TOKEN = /\{env:([A-Z_][A-Z0-9_]*)\}/g;

export function parseMcpArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
  } catch {
    // Fall through: a plain space-separated string is also accepted.
  }
  return raw.trim().split(/\s+/).filter(Boolean);
}

export function fillWorkspaceToken(args: string[], workspaceRoot: string): string[] {
  return args.map((arg) =>
    arg === WORKSPACE_TOKEN ? workspaceRoot : arg.replaceAll(WORKSPACE_TOKEN, workspaceRoot)
  );
}

async function decryptServerEnv(
  config: Pick<McpServerConfig, "envCiphertext" | "name">
): Promise<Record<string, string>> {
  if (!config.envCiphertext) return {};
  const plain = await decryptApiKey(config.envCiphertext, `MCP server ${config.name}`);
  const parsed = JSON.parse(plain) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export async function resolveMcpSpawn(config: McpServerConfig, workspaceRoot: string): Promise<McpSpawnSpec> {
  if (!config.command) throw new Error("No local command configured for this MCP server.");
  const env = await decryptServerEnv(config);
  const missing: string[] = [];
  const args = fillWorkspaceToken(parseMcpArgs(config.args), workspaceRoot).map((arg) =>
    arg.replace(ENV_TOKEN, (_match, key: string) => {
      const value = env[key];
      if (value === undefined) {
        missing.push(key);
        return "";
      }
      return value;
    })
  );
  if (missing.length > 0) {
    throw new Error(`Missing secret ${[...new Set(missing)].join(", ")} for MCP server ${config.name}.`);
  }
  return {
    command: config.command,
    args,
    env,
    secretValues: Object.values(env).filter((value) => value.length >= 4),
  };
}

/** Replace every configured secret value in a message with ••••. */
export function redactSecrets(text: string, secretValues: string[]): string {
  let out = text;
  for (const value of secretValues) {
    if (value) out = out.split(value).join("••••");
  }
  return out;
}
