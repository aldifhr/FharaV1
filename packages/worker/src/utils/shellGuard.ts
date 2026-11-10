/**
 * L2: shell guard against commands that print or send secrets. Shared by
 * the command gate (`execution/commandGate.ts`, shell agent) and the
 * process tools (`tools/runCommand.ts`, `tools/runPty.ts`). Built on the
 * OAK shell-export policy copied in `./shellExportPolicy.ts`.
 */
import {
  SHELL_EXPORT_RULES,
  classifyShellExport,
  containsSecretReaderSubstitution,
  containsSensitiveEnvironmentReference,
  splitShellCommands,
  tokenizeShellWords,
} from "./shellExportPolicy";


/** Rule names the command gate refuses with (stable: shown to the agent and in events). */
export const SHELL_GUARD_RULES = {
  ...SHELL_EXPORT_RULES,
  ENV_DUMP: "shell-environment-dump",
  SECRET_FILE_READ: "shell-secret-file-read",
  SECRET_EXFILTRATION: "shell-secret-exfiltration",
  SECRET_ECHO: "shell-secret-echo",
} as const;

export interface ShellGuardDecision {
  rule: string;
  reason: string;
}

const ENV_DUMP_REASON = "it prints the environment, which holds the worker's credentials";

/** Programs that print a file's contents. */
const FILE_READERS = new Set([
  "cat", "tac", "less", "more", "head", "tail", "strings", "base64", "xxd", "od", "hexdump",
  "nl", "bat", "sed", "awk", "grep", "rg", "cut", "sort", "uniq",
]);
/** Programs that send data off the machine. */
const NETWORK_SENDERS = new Set(["curl", "wget", "nc", "ncat", "netcat", "socat", "ssh", "scp", "rsync", "ftp", "telnet", "http", "https"]);

/** A path whose contents are credentials (same names the staged-file secret scan blocks). */
export function isSecretFilePath(raw: string): boolean {
  const word = raw.replace(/^['"]|['"]$/g, "").replace(/^<+/, "");
  if (/^\/proc\/[^/]+\/environ$/.test(word)) return true;
  const name = word.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name === ".env") return true;
  if (name.startsWith(".env.") && ![".env.example", ".env.sample", ".env.template"].includes(name)) return true;
  if (["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".netrc", ".git-credentials", ".npmrc", ".pypirc"].includes(name)) return true;
  if (/\.(?:pem|key|p12|pfx)$/i.test(name)) return true;
  if (/(?:^|[\\/])\.aws[\\/]credentials$/.test(word) || /(?:^|[\\/])\.docker[\\/]config\.json$/.test(word)) return true;
  return false;
}

/** The program a segment runs, past `VAR=x` prefixes and `sudo`/`command`/`exec`/`nohup`/`time`. */
function programOf(words: string[]): { program: string; rest: string[] } {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i += 1; continue; }
    if (["sudo", "command", "exec", "nohup", "time", "builtin"].includes(w)) { i += 1; continue; }
    break;
  }
  const program = (words[i] ?? "").replace(/^.*[\\/]/, "");
  return { program, rest: words.slice(i + 1) };
}

/** `env` with no command to run (only flags / assignments) prints the environment. */
function envPrintsEnvironment(rest: string[]): boolean {
  let i = 0;
  while (i < rest.length) {
    const w = rest[i];
    if (w === "-u" || w === "--unset" || w === "-C" || w === "--chdir" || w === "-S" || w === "--split-string") {
      if (w === "-S" || w === "--split-string") return false;
      i += 2;
      continue;
    }
    if (w.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i += 1; continue; }
    return false;
  }
  return true;
}

/**
 * Refuse a shell command line that would print or send secrets: environment
 * dumps (`env`, `printenv`, `set`, `export -p`, `declare -x`, `/proc/…/environ`),
 * exporting a secret-named variable or filling one from a secret source
 * (OAK shell-export policy), reading a credential file (`cat .env`), piping
 * one to the network (`cat .env | curl …`), and echoing a secret variable.
 * Returns null when the command may run (`export NODE_ENV=production`).
 */
export function shellGuardDecision(commandLine: string): ShellGuardDecision | null {
  if (!commandLine || !commandLine.trim()) return null;
  const exported = classifyShellExport(commandLine);
  if (exported.blocked && exported.rule) {
    const why =
      exported.rule === SHELL_EXPORT_RULES.ENVIRONMENT_ENUMERATION
        ? ENV_DUMP_REASON
        : exported.rule === SHELL_EXPORT_RULES.SENSITIVE_NAME
          ? "it exports a secret-named variable into the shell environment"
          : "it copies a secret into an exported variable";
    return { rule: exported.rule, reason: why };
  }
  let readsSecretFile = false;
  let sendsToNetwork = false;
  for (const segment of splitShellCommands(commandLine)) {
    const words = tokenizeShellWords(segment.trim());
    if (words.length === 0) continue;
    const { program, rest } = programOf(words);
    const lower = program.toLowerCase();
    // The OAK tokenizer splits an unquoted `$(vault read x)` at its spaces,
    // so check the whole export segment for a secret-reader substitution too.
    if (lower === "export" && containsSecretReaderSubstitution(segment)) {
      return { rule: SHELL_EXPORT_RULES.SECRET_SOURCE, reason: "it copies a secret into an exported variable" };
    }
    if (lower === "printenv") return { rule: SHELL_GUARD_RULES.ENV_DUMP, reason: ENV_DUMP_REASON };
    if (lower === "env" && envPrintsEnvironment(rest)) return { rule: SHELL_GUARD_RULES.ENV_DUMP, reason: ENV_DUMP_REASON };
    if (lower === "set" && rest.length === 0) return { rule: SHELL_GUARD_RULES.ENV_DUMP, reason: ENV_DUMP_REASON };
    if ((lower === "declare" || lower === "typeset") && rest.some((w) => /^-[a-zA-Z]*[xp]/.test(w)) && !rest.some((w) => w.includes("="))) {
      return { rule: SHELL_GUARD_RULES.ENV_DUMP, reason: ENV_DUMP_REASON };
    }
    if (lower === "compgen" && rest.some((w) => /^-[a-zA-Z]*[ve]/.test(w))) return { rule: SHELL_GUARD_RULES.ENV_DUMP, reason: ENV_DUMP_REASON };
    if (words.some((w) => /\/proc\/[^/\s]+\/environ\b/.test(w))) return { rule: SHELL_GUARD_RULES.ENV_DUMP, reason: ENV_DUMP_REASON };
    if (/^(?:node|deno|bun)$/.test(lower) && rest.some((w) => /^-(?:e|p|-eval|-print)$/.test(w)) && /process\.env(?![.[]\s*\w)/.test(segment)) {
      return { rule: SHELL_GUARD_RULES.ENV_DUMP, reason: ENV_DUMP_REASON };
    }
    if (/^python[0-9.]*$/.test(lower) && rest.includes("-c") && /os\.environ(?!\s*[.[]\s*(?:get\b|['"]))/.test(segment)) {
      return { rule: SHELL_GUARD_RULES.ENV_DUMP, reason: ENV_DUMP_REASON };
    }
    if ((lower === "echo" || lower === "printf") && containsSensitiveEnvironmentReference(rest.join(" "))) {
      return { rule: SHELL_GUARD_RULES.SECRET_ECHO, reason: "it prints a secret variable" };
    }
    if (NETWORK_SENDERS.has(lower)) {
      sendsToNetwork = true;
      // `curl -d @.env` / `curl -T .env`: the upload reads the file itself.
      if (rest.some((w) => isSecretFilePath(w.replace(/^@/, "")))) readsSecretFile = true;
    }
    const fileArgs = rest.filter((w) => !w.startsWith("-") || w.startsWith("@"));
    if ((FILE_READERS.has(lower) && fileArgs.some(isSecretFilePath)) || words.some((w) => /^<\S+/.test(w) && isSecretFilePath(w.slice(1)))) {
      readsSecretFile = true;
    }
    // `< .env` as its own word.
    const redirect = words.indexOf("<");
    if (redirect >= 0 && words[redirect + 1] && isSecretFilePath(words[redirect + 1])) readsSecretFile = true;
  }
  if (readsSecretFile && sendsToNetwork) {
    return { rule: SHELL_GUARD_RULES.SECRET_EXFILTRATION, reason: "it sends a credential file over the network" };
  }
  if (readsSecretFile) return { rule: SHELL_GUARD_RULES.SECRET_FILE_READ, reason: "it prints a credential file" };
  return null;
}

/** The text the agent gets back when the shell guard refused a command. */
export function shellGuardOutput(line: string, decision: ShellGuardDecision): string {
  return `Command not run: ${line}\nReason: blocked by rule ${decision.rule} (${decision.reason}).`;
}

/** argv form: quote words with spaces so the line re-splits the same way. */
export function shellGuardDecisionForArgv(command: string, args: readonly string[]): ShellGuardDecision | null {
  const quote = (w: string) => (/[\s;&|<>]/.test(w) ? `'${w.replace(/'/g, `'\\''`)}'` : w);
  return shellGuardDecision([command, ...args].map(quote).join(" "));
}
