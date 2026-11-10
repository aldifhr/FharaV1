/**
 * O1: a throwaway HOME/XDG tree for one OpenCode run, holding only the
 * provider login that run needs.
 *
 * The run's env comes from `buildChildEnv(scopedHome(runDir))`, so the
 * agent's `~` is an empty dir under the run's temp folder: the user's real
 * `~/.ssh`, `~/.config/gh`, `~/.git-credentials` and OpenCode auth store
 * are not where `~` points. Then, so a login made with `opencode auth
 * login` keeps working, the ONE provider entry the run uses is copied from
 * the user's real `auth.json` into the scratch data dir (0600), and that
 * provider's block from the user's global OpenCode config is merged into
 * the generated per-run config.
 *
 * Credential rule (ported from jockey `src-tauri/src/credentials/mod.rs`,
 * MIT, © 2026 JockeyUI Contributors; rewritten in TypeScript for Fhara,
 * see THIRD_PARTY_NOTICES.md): a provider the run is bound to that has no
 * readable login is an ERROR, never a silent switch to another account,
 * which would bill the wrong one. Modified by Fhara: applied to OpenCode's
 * auth store and global config instead of jockey's credential profiles.
 */
import { wenv } from "@fhara/config/worker";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SCOPED_HOME_DIRS, scopedHome } from "@/api/convex/lib/childEnv";

/** Providers OpenCode can run without any stored login. */
const KEYLESS_PROVIDERS = new Set(["opencode", "ollama", "lmstudio", "llama.cpp", "llamacpp"]);

export interface PrepareOpencodeHomeInput {
  /** The run's temp dir; the scratch tree goes under `<runDir>/`. */
  runDir: string;
  /**
   * "pinned": the run is pinned to an OpenCode model `provider/model` and
   *   uses OpenCode's own login for `provider`.
   * "fhara": the run uses Fhara's generated provider; its key travels in
   *   the env, so no OpenCode login is copied.
   * "default": no model pinned; the user's own OpenCode default applies.
   */
  mode: "pinned" | "fhara" | "default";
  /** `provider/model` when pinned. */
  model?: string;
  /** The user's real env (HOME / XDG_* locate the real OpenCode files). Defaults to process.env. */
  sourceEnv?: Record<string, string | undefined>;
  /** Persistent, credential-free cache dir (OpenCode's provider packages). */
  cacheDir?: string;
}

export interface PreparedOpencodeHome {
  /** Env overrides to merge into the child env (from childEnv.scopedHome). */
  env: Record<string, string | undefined>;
  /** Provider ids whose OpenCode login was copied in. */
  copiedProviders: string[];
  /** Provider config blocks from the user's global OpenCode config, by id. */
  providerConfig: Record<string, unknown>;
  /** The model to pin when the run had none (the user's configured default). */
  defaultModel?: string;
  /** One line for the run log. */
  note: string;
}

export class OpencodeCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpencodeCredentialError";
  }
}

/** Default persistent cache: FHARA_OPENCODE_CACHE_DIR or `<tmp>/fhara-opencode-cache`. */
export function defaultOpencodeCacheDir(env?: Record<string, string | undefined>): string {
  return wenv("FHARA_OPENCODE_CACHE_DIR", env) || path.join(os.tmpdir(), "fhara-opencode-cache");
}

function realHome(env: Record<string, string | undefined>): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/** Where the user's real OpenCode files live (xdg-basedir layout OpenCode uses on every OS). */
export function realOpencodePaths(env: Record<string, string | undefined> = process.env): {
  authFile: string;
  configFiles: string[];
} {
  const home = realHome(env);
  const data = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const config = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const dir = path.join(config, "opencode");
  return {
    authFile: path.join(data, "opencode", "auth.json"),
    configFiles: ["config.json", "opencode.json", "opencode.jsonc"].map((name) => path.join(dir, name)),
  };
}

/** Strip `//` and block comments (outside strings) and trailing commas, then parse. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

async function readJson(file: string, jsonc = false): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = jsonc ? parseJsonc(text) : JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The user's merged global OpenCode config (later files win, shallow). */
async function readGlobalConfig(files: string[]): Promise<Record<string, unknown>> {
  const merged: Record<string, unknown> = {};
  for (const file of files) {
    const parsed = await readJson(file, true);
    if (!parsed) continue;
    const provider = { ...((merged.provider as Record<string, unknown>) ?? {}), ...((parsed.provider as Record<string, unknown>) ?? {}) };
    Object.assign(merged, parsed, { provider });
  }
  return merged;
}

/** Whether the scrubbed child env carries a key that looks like it is for `provider` (e.g. ANTHROPIC_API_KEY). */
function envHasProviderKey(provider: string, childEnv: Record<string, string | undefined>): boolean {
  const prefix = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return Object.entries(childEnv).some(([key, value]) => !!value && key.toUpperCase().startsWith(`${prefix}_`) && /KEY|TOKEN/.test(key.toUpperCase()));
}

/**
 * Create the scratch tree and copy in the one login the run needs.
 * Throws OpencodeCredentialError when a pinned provider has no login
 * (jockey rule: no fallback to another account).
 */
export async function prepareOpencodeHome(
  input: PrepareOpencodeHomeInput,
  /** The scrubbed child env (for the "key comes from the env" case). */
  childEnv: Record<string, string | undefined> = {}
): Promise<PreparedOpencodeHome> {
  const source = input.sourceEnv ?? process.env;
  const cacheDir = input.cacheDir ?? defaultOpencodeCacheDir(source);
  const env = scopedHome(input.runDir, {
    cacheDir,
    devNull: os.devNull,
    sep: path.sep,
  });
  for (const dir of SCOPED_HOME_DIRS) await fs.mkdir(path.join(input.runDir, dir), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(cacheDir, "npm"), { recursive: true, mode: 0o700 });
  const scratchAuthDir = path.join(input.runDir, "data", "opencode");
  await fs.mkdir(scratchAuthDir, { recursive: true, mode: 0o700 });

  if (input.mode === "fhara") {
    return { env, copiedProviders: [], providerConfig: {}, note: "scoped home; Fhara provider key from env, no OpenCode login copied" };
  }

  const real = realOpencodePaths(source);
  const auth = (await readJson(real.authFile)) ?? {};
  const globalConfig = await readGlobalConfig(real.configFiles);
  const userProviders = (globalConfig.provider as Record<string, unknown> | undefined) ?? {};

  let providers: string[];
  let defaultModel: string | undefined;
  let note: string;
  if (input.mode === "pinned") {
    const provider = (input.model ?? "").split("/")[0]?.trim() ?? "";
    if (!provider) throw new OpencodeCredentialError(`OpenCode model "${input.model ?? ""}" names no provider`);
    const hasLogin = provider in auth || provider in userProviders || envHasProviderKey(provider, childEnv);
    if (!hasLogin && !KEYLESS_PROVIDERS.has(provider.toLowerCase())) {
      throw new OpencodeCredentialError(
        `provider key unreadable: OpenCode has no login for "${provider}" on this machine (no \`opencode auth login\` entry and no provider config). Fhara will not run it with another account; sign in with \`opencode auth login\` or pick another model.`
      );
    }
    providers = [provider];
    note = `scoped home; OpenCode login copied for ${provider} only`;
  } else {
    const configured = typeof globalConfig.model === "string" ? globalConfig.model.trim() : "";
    const provider = configured.split("/")[0] ?? "";
    if (configured && provider) {
      providers = [provider];
      defaultModel = configured;
      note = `scoped home; no model pinned, using your OpenCode default ${configured}; login copied for ${provider} only`;
    } else {
      providers = Object.keys(auth);
      note =
        providers.length > 0
          ? `scoped home; no model pinned and no OpenCode default model, so every OpenCode provider login was copied (${providers.join(", ")}). Pin a model to scope it to one.`
          : "scoped home; no model pinned and no OpenCode login found";
    }
  }

  const scopedAuth: Record<string, unknown> = {};
  const providerConfig: Record<string, unknown> = {};
  for (const id of providers) {
    if (id in auth) scopedAuth[id] = auth[id];
    if (id in userProviders) providerConfig[id] = userProviders[id];
  }
  const copiedProviders = Object.keys(scopedAuth);
  if (copiedProviders.length > 0) {
    await fs.writeFile(path.join(scratchAuthDir, "auth.json"), JSON.stringify(scopedAuth, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
  return { env, copiedProviders, providerConfig, ...(defaultModel ? { defaultModel } : {}), note };
}
