/**
 * L2: secret scan of staged files, before apply and before push.
 *
 * `detectPossibleSecretReasons` is a TypeScript rewrite of
 * `detect_possible_secret_reasons` / `contains_token` from llm-wiki-cli
 * (https://github.com/JanYork/llm-wiki-cli, `src/secret_scan.rs`, commit
 * e1be6ab). Copyright the llm-wiki-cli authors. Licensed under the Apache
 * License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
 *
 * Modified by Fhara: rewritten from Rust in TypeScript (same rules: `.env*`
 * except example/sample/template, ssh private-key names and .key/.p12/.pfx,
 * PEM private-key markers, AKIA/ASIA/ghp_/github_pat_/sk-proj-/xoxb-/xoxp-
 * tokens with the same minimum lengths); added the staged-change and
 * outgoing-diff wrappers below, which only look at text the change adds.
 */
import path from "node:path";

/** The parts of a staged change the scan reads (structurally a tools/gitDiff FileDiff). */
export interface ScannedChange {
  filePath: string;
  changeType: "new" | "modified" | "deleted";
  oldContent?: string;
  newContent?: string;
}

const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const PRIVATE_KEY_NAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const PRIVATE_KEY_EXTENSIONS = ["key", "p12", "pfx"];
const PRIVATE_KEY_MARKERS = [
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "-----BEGIN PGP PRIVATE KEY BLOCK-----",
];
const TOKEN_PREFIXES: ReadonlyArray<readonly [string, number]> = [
  ["AKIA", 20],
  ["ASIA", 20],
  ["ghp_", 20],
  ["github_pat_", 24],
  ["sk-proj-", 24],
  ["xoxb-", 24],
  ["xoxp-", 24],
];

export type SecretReason =
  | "environment credential file"
  | "private-key or credential file"
  | "private-key marker"
  | "known credential prefix";

/** Reasons the file name alone gives. */
export function fileNameSecretReasons(filePath: string): SecretReason[] {
  const reasons: SecretReason[] = [];
  const name = path.posix.basename(filePath.replace(/\\/g, "/")).toLowerCase();
  const envFile = name === ".env" || (name.startsWith(".env.") && !ENV_TEMPLATES.has(name));
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const privateFile =
    PRIVATE_KEY_NAMES.has(name) || (extension !== "" && name !== `.${extension}` && PRIVATE_KEY_EXTENSIONS.includes(extension));
  if (envFile) reasons.push("environment credential file");
  if (privateFile) reasons.push("private-key or credential file");
  return reasons;
}

function containsToken(content: string, prefix: string, minimumLength: number): boolean {
  let index = content.indexOf(prefix);
  while (index !== -1) {
    let length = 0;
    for (let i = index; i < content.length; i += 1) {
      const c = content.charCodeAt(i);
      const ok =
        (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 /* _ */ || c === 45; /* - */
      if (!ok) break;
      length += 1;
    }
    if (length >= minimumLength) return true;
    index = content.indexOf(prefix, index + 1);
  }
  return false;
}

/** Reasons the content gives. */
export function contentSecretReasons(content: string): SecretReason[] {
  const reasons: SecretReason[] = [];
  if (!content) return reasons;
  if (PRIVATE_KEY_MARKERS.some((marker) => content.includes(marker))) reasons.push("private-key marker");
  if (TOKEN_PREFIXES.some(([prefix, minimum]) => containsToken(content, prefix, minimum))) reasons.push("known credential prefix");
  return reasons;
}

/** Port of `detect_possible_secret_reasons(path, content)`. */
export function detectPossibleSecretReasons(filePath: string, content: string): SecretReason[] {
  return [...fileNameSecretReasons(filePath), ...contentSecretReasons(content)];
}

export interface SecretFinding {
  filePath: string;
  reasons: SecretReason[];
}

/** Lines of `next` that `prev` does not have (multiset difference). */
export function addedLines(prev: string | undefined, next: string): string {
  if (!prev) return next;
  const counts = new Map<string, number>();
  for (const line of prev.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of next.split("\n")) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else added.push(line);
  }
  return added.join("\n");
}

/**
 * Secret findings in staged changes. Deleted files are ignored; a file's
 * name always counts (a staged `.env` is a finding even when it only
 * changed); content counts only for what the change adds, so a file that
 * already held a fixture token is not flagged for an unrelated edit.
 */
export function scanStagedChanges(changes: readonly ScannedChange[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const change of changes) {
    if (change.changeType === "deleted") continue;
    const content = addedLines(change.changeType === "new" ? undefined : change.oldContent, change.newContent ?? "");
    const reasons = [...new Set([...fileNameSecretReasons(change.filePath), ...contentSecretReasons(content)])];
    if (reasons.length > 0) findings.push({ filePath: change.filePath, reasons });
  }
  return findings;
}

/**
 * Findings in a unified diff (`git diff -U0`): names of files the diff adds
 * or changes, and the content of its `+` lines.
 */
export function scanUnifiedDiff(diff: string): SecretFinding[] {
  const byFile = new Map<string, { added: string[]; deleted: boolean }>();
  let current: { added: string[]; deleted: boolean } | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        current = null;
        continue;
      }
      const filePath = target.replace(/^"?b\//, "").replace(/"$/, "");
      current = byFile.get(filePath) ?? { added: [], deleted: false };
      byFile.set(filePath, current);
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (current && line.startsWith("+")) current.added.push(line.slice(1));
  }
  const findings: SecretFinding[] = [];
  for (const [filePath, entry] of byFile) {
    const reasons = [...new Set([...fileNameSecretReasons(filePath), ...contentSecretReasons(entry.added.join("\n"))])];
    if (reasons.length > 0) findings.push({ filePath, reasons });
  }
  return findings;
}

/** One plain-words line per finding, for approvals, events and errors. */
export function secretFindingsSummary(findings: readonly SecretFinding[]): string {
  return findings.map((f) => `${f.filePath} (${f.reasons.join(", ")})`).join("; ");
}

/** Warning text shown on the approval (the `secret_detected` flag's body). */
export function secretWarning(findings: readonly SecretFinding[]): string | null {
  if (findings.length === 0) return null;
  return `Possible secret detected — review before approving: ${secretFindingsSummary(findings)}. Auto-approval is off for this batch.`;
}

/** Approval payload fields for staged secrets (L2): `flags: ["secret_detected"]` + findings. */
export function secretFlag(findings: readonly SecretFinding[]): Record<string, unknown> {
  if (findings.length === 0) return {};
  return {
    flags: ["secret_detected"],
    secretDetected: true,
    secretFindings: findings.map((f) => ({ filePath: f.filePath, reasons: f.reasons })),
  };
}
