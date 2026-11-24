"use node";

import { execFileSync } from "node:child_process";
import { internalAction } from "@fhara/runtime/functions";
import { buildChildEnv } from "./lib/childEnv";

/**
 * Plan 079: read the operator's GitHub credential from the Git CLI
 * (https://git-scm.com/), never from an OAuth app or the GitHub CLI.
 *
 * `git credential fill` asks Git's configured credential helper — Windows
 * Credential Manager, macOS Keychain, `git-credential-store`, or whatever
 * the operator installed — for the https://github.com entry. It returns
 * `username=<login>` and `password=<token>`. Both are read from stdin/stdout
 * only: no shell, no argv, no log. The token is handed to the caller so it
 * can be sealed with PROVIDER_ENCRYPTION_KEY by
 * `integrations.upsertGithubIntegration`; it is never returned to a client.
 */
const CLI_TIMEOUT_MS = 15_000;

export const readLocalCredential = internalAction({
  args: {},
  handler: async (): Promise<{ token: string; login?: string } | { error: string }> => {
    // Keep the real HOME/APPDATA so Git finds the user's credential helper,
    // but drop inherited GIT_* so a caller cannot inject GIT_CONFIG_COUNT,
    // GIT_DIR or a fake helper. GIT_TERMINAL_PROMPT=0 keeps this non-interactive.
    const env: Record<string, string | undefined> = { ...buildChildEnv() };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_OPTIONAL_LOCKS = "0";

    let output: string;
    try {
      output = execFileSync("git", ["credential", "fill"], {
        input: "protocol=https\nhost=github.com\n\n",
        encoding: "utf8",
        windowsHide: true,
        env,
        timeout: CLI_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      return {
        error:
          "No GitHub credential is configured for Git. Set one up with a Git credential helper (https://git-scm.com/docs/gitcredentials), then try again.",
      };
    }

    const fields: Record<string, string> = {};
    for (const line of output.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0) fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    const token = fields.password ?? "";
    if (!token || /[\r\n]/.test(token)) {
      return { error: "The Git credential helper returned no usable GitHub password/token." };
    }
    const login = fields.username?.match(/^[A-Za-z0-9-]{1,100}$/)?.[0];
    return { token, ...(login ? { login } : {}) };
  },
});
