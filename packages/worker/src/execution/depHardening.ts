/**
 * O8: dependency check on a diff.
 *
 * Looks only at what a change does to dependency files (package.json,
 * lockfiles, CI workflows) and reports findings in the Reviewer severity
 * scale. A "high" finding never lets the change be auto-approved and marks
 * the push's dependencyCheck "failed", which blocks supervised auto-merge
 * (apps/api/convex/lib/autoMerge.ts). No network: `npm audit` runs only when
 * a runner is injected, and its absence is an "info" finding, never a failure.
 *
 * Written for Fhara (no code copied). The known-bad list is public incident
 * history (event-stream/flatmap-stream 2018, eslint-scope 2018, ua-parser-js /
 * coa / rc 2021, colors / faker / node-ipc 2022).
 */
import * as path from "node:path";

export type DepSeverity = "high" | "medium" | "low" | "info";

export interface DepFinding {
  severity: DepSeverity;
  code:
    | "parse-error"
    | "known-bad"
    | "typosquat"
    | "non-exact-range"
    | "non-registry-source"
    | "lockfile-missing"
    | "lockfile-drift"
    | "lockfile-only"
    | "ci-deterministic-install"
    | "install-script"
    | "audit"
    | "audit-skipped";
  file: string;
  message: string;
  package?: string;
}

export interface DepCheckResult {
  /** "skipped": the diff touched no dependency file. "failed": at least one high finding. */
  status: "passed" | "failed" | "skipped";
  high: number;
  findings: DepFinding[];
  summary: string;
}

export interface DepFileChange {
  filePath: string;
  changeType: "new" | "modified" | "deleted";
  oldContent?: string;
  newContent?: string;
}

export interface DepCheckOptions {
  /** Whether a repo-relative file exists after the change (lockfile lookups). */
  fileExists?: (relPath: string) => boolean;
  /** Optional `npm audit --json` runner (never called in tests). Null → "audit skipped". */
  runAudit?: ((dir: string) => Promise<{ high: number; critical: number; moderate: number } | null>) | null;
}

const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock"];
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/** Versions with a public compromise (exact matches). `*` = every version of a squatted name. */
export const KNOWN_BAD: Readonly<Record<string, readonly string[]>> = {
  "event-stream": ["3.3.6"],
  "flatmap-stream": ["*"],
  "eslint-scope": ["3.7.2"],
  "eslint-config-eslint": ["5.0.2"],
  "ua-parser-js": ["0.7.29", "0.8.0", "1.0.0"],
  coa: ["2.0.3", "2.0.4", "2.1.1", "2.1.3", "3.0.1", "3.1.3"],
  rc: ["1.2.9", "1.3.9", "2.3.9"],
  colors: ["1.4.1", "1.4.2", "1.4.44-liberty-2"],
  faker: ["6.6.6"],
  "node-ipc": ["10.1.1", "10.1.2", "10.1.3", "11.0.0", "11.1.0"],
  "peacenotwar": ["*"],
  "crossenv": ["*"],
  "cross-env.js": ["*"],
  "discord.dll": ["*"],
};

/** Popular package names a squatter imitates (a name 1 edit away, not itself on this list, is flagged). */
export const POPULAR_PACKAGES: readonly string[] = [
  "react", "react-dom", "next", "vue", "angular", "svelte", "express", "koa", "fastify", "lodash", "underscore",
  "axios", "request", "node-fetch", "chalk", "commander", "yargs", "debug", "dotenv", "moment", "dayjs", "uuid",
  "typescript", "eslint", "prettier", "webpack", "vite", "rollup", "esbuild", "babel-core", "jest", "vitest",
  "mocha", "chai", "zod", "convex", "electron", "socket.io", "mongoose", "mysql", "pg", "redis", "ioredis",
  "jsonwebtoken", "bcrypt", "cors", "body-parser", "cross-env", "rimraf", "glob", "minimist", "semver",
  "colors", "async", "bluebird", "classnames", "tailwindcss", "postcss", "autoprefixer", "sharp", "openai",
  "puppeteer", "playwright", "nodemon", "ws", "graphql", "prisma", "sequelize", "knex", "ethers", "web3",
];

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else if (a[i + 1] === b[j] && a[i] === b[j + 1]) {
      // transposition counts as one edit
      i += 2;
      j += 2;
    } else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** The popular package `name` imitates, or null. Scoped names compare their bare part only when the scope is unusual. */
export function typosquatTarget(name: string): string | null {
  const lower = name.toLowerCase();
  if (POPULAR_PACKAGES.includes(lower)) return null;
  const bare = lower.startsWith("@") ? lower.split("/")[1] ?? lower : lower;
  if (lower.startsWith("@") && POPULAR_PACKAGES.includes(bare)) return null; // @types/react etc.
  const squashed = bare.replace(/[-_.]/g, "");
  for (const popular of POPULAR_PACKAGES) {
    if (bare.length < 4 && popular.length < 4) continue; // too short to judge
    if (editDistanceAtMostOne(bare, popular)) return popular;
    if (squashed === popular.replace(/[-_.]/g, "") && bare !== popular) return popular;
  }
  return null;
}

type DepMap = Record<string, string>;

function parseManifest(content: string | undefined): { ok: true; deps: DepMap; scripts: Record<string, string> } | { ok: false; error: string } {
  if (content === undefined) return { ok: true, deps: {}, scripts: {} };
  try {
    const json = JSON.parse(content) as Record<string, unknown>;
    const deps: DepMap = {};
    for (const field of DEP_FIELDS) {
      const block = json[field];
      if (block && typeof block === "object" && !Array.isArray(block)) {
        for (const [name, spec] of Object.entries(block as Record<string, unknown>)) if (typeof spec === "string") deps[name] = spec;
      }
    }
    const scripts = json.scripts && typeof json.scripts === "object" ? (json.scripts as Record<string, string>) : {};
    return { ok: true, deps, scripts };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const EXACT = /^=?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NON_REGISTRY = /^(?:git(?:\+[a-z]+)?:|github:|gitlab:|bitbucket:|https?:|file:|link:|[\w.-]+\/[\w.-]+(?:#.*)?$)/i;

function exactVersion(spec: string): string | null {
  const m = /^=?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(spec.trim());
  return m && EXACT.test(spec.trim()) ? m[1] : null;
}

function isBad(name: string, spec: string): boolean {
  const versions = KNOWN_BAD[name];
  if (!versions) return false;
  if (versions.includes("*")) return true;
  const exact = exactVersion(spec);
  if (exact) return versions.includes(exact);
  // A range that admits a bad version (e.g. "^3.3.5" admits 3.3.6): flag when any bad version shares the major.
  const major = /(\d+)\./.exec(spec)?.[1];
  return !!major && versions.some((v) => v.startsWith(`${major}.`)) && /^[\^~]|^>=/.test(spec.trim());
}

const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare"];
const CI_FILE = /^(?:\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|\.circleci\/config\.ya?ml|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml)$/i;

function lockfileNear(manifest: string, exists: (p: string) => boolean): string | null {
  let dir = path.posix.dirname(manifest);
  for (;;) {
    for (const lock of LOCKFILES) {
      const candidate = dir === "." ? lock : `${dir}/${lock}`;
      if (exists(candidate)) return candidate;
    }
    if (dir === "." || dir === "/" || dir === "") return null;
    dir = path.posix.dirname(dir);
  }
}

/** Run the dependency check over a set of changed files. */
export async function checkDependencyChanges(changes: readonly DepFileChange[], opts: DepCheckOptions = {}): Promise<DepCheckResult> {
  const findings: DepFinding[] = [];
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const byPath = new Map(changes.map((c) => [norm(c.filePath), c]));
  const changedLockfiles = new Set([...byPath.keys()].filter((p) => LOCKFILES.includes(path.posix.basename(p))));
  const exists = (p: string) => {
    const change = byPath.get(p);
    if (change) return change.changeType !== "deleted";
    return opts.fileExists ? opts.fileExists(p) : false;
  };
  let relevant = false;
  const manifestsWithDepChanges: string[] = [];

  for (const [file, change] of byPath) {
    const base = path.posix.basename(file);
    if (base === "package.json" && change.changeType !== "deleted") {
      relevant = true;
      const before = parseManifest(change.oldContent);
      const after = parseManifest(change.newContent);
      if (!after.ok) {
        findings.push({ severity: "high", code: "parse-error", file, message: `package.json does not parse: ${after.error}` });
        continue;
      }
      const old = before.ok ? before.deps : {};
      let depChanged = false;
      for (const [name, spec] of Object.entries(after.deps)) {
        if (old[name] === spec) continue;
        depChanged = true;
        const what = old[name] === undefined ? `new dependency ${name}@${spec}` : `${name} ${old[name]} → ${spec}`;
        if (isBad(name, spec)) findings.push({ severity: "high", code: "known-bad", file, package: name, message: `${what}: a version of ${name} with a known compromise` });
        const squat = old[name] === undefined ? typosquatTarget(name) : null;
        if (squat) findings.push({ severity: "high", code: "typosquat", file, package: name, message: `${what}: the name is one edit away from "${squat}" (possible typosquat)` });
        if (NON_REGISTRY.test(spec.trim()) && !/^(?:workspace:|npm:)/.test(spec)) {
          findings.push({ severity: "medium", code: "non-registry-source", file, package: name, message: `${what}: installed from outside the registry` });
        } else if (!exactVersion(spec) && !/^(?:workspace:|npm:|catalog:)/.test(spec)) {
          findings.push({ severity: "medium", code: "non-exact-range", file, package: name, message: `${what}: non-exact range; pin an exact version` });
        }
      }
      if (Object.keys(old).some((name) => !(name in after.deps))) depChanged = true;
      const oldScripts = before.ok ? before.scripts : {};
      for (const hook of INSTALL_HOOKS) {
        const script = after.scripts[hook];
        if (typeof script === "string" && script !== oldScripts[hook]) {
          findings.push({ severity: "medium", code: "install-script", file, message: `"${hook}" script added or changed: ${script.slice(0, 120)}` });
        }
      }
      if (depChanged) manifestsWithDepChanges.push(file);
    } else if (LOCKFILES.includes(base)) {
      relevant = true;
    } else if (CI_FILE.test(file) && change.newContent !== undefined) {
      relevant = true;
      const added = change.newContent.split(/\r?\n/).filter((line) => !(change.oldContent ?? "").split(/\r?\n/).includes(line));
      for (const line of added) {
        if (/\b(?:npm\s+(?:install|i)\b(?!\s+-g)|yarn\s+install\b(?!.*--(?:frozen-lockfile|immutable))|pnpm\s+install\b(?!.*--frozen-lockfile))/.test(line) && !/npm\s+ci\b/.test(line)) {
          findings.push({ severity: "medium", code: "ci-deterministic-install", file, message: `CI installs without the lockfile: "${line.trim().slice(0, 100)}" (use npm ci / --frozen-lockfile)` });
        }
      }
    }
  }

  for (const manifest of manifestsWithDepChanges) {
    const lock = lockfileNear(manifest, exists);
    if (!lock) findings.push({ severity: "high", code: "lockfile-missing", file: manifest, message: "Dependencies changed and there is no lockfile; installs are not reproducible" });
    else if (!changedLockfiles.has(lock)) findings.push({ severity: "medium", code: "lockfile-drift", file: lock, message: `${manifest} changed its dependencies but ${lock} did not change` });
  }
  if (manifestsWithDepChanges.length === 0) {
    for (const lock of changedLockfiles) {
      findings.push({ severity: "low", code: "lockfile-only", file: lock, message: "Lockfile changed without a package.json dependency change; check the resolved versions" });
    }
  }

  if (relevant && manifestsWithDepChanges.length > 0) {
    if (opts.runAudit) {
      try {
        const audit = await opts.runAudit(".");
        if (!audit) findings.push({ severity: "info", code: "audit-skipped", file: manifestsWithDepChanges[0], message: "npm audit unavailable; audit skipped" });
        else if (audit.critical + audit.high > 0)
          findings.push({ severity: "high", code: "audit", file: manifestsWithDepChanges[0], message: `npm audit: ${audit.critical} critical, ${audit.high} high` });
        else if (audit.moderate > 0)
          findings.push({ severity: "low", code: "audit", file: manifestsWithDepChanges[0], message: `npm audit: ${audit.moderate} moderate` });
      } catch {
        findings.push({ severity: "info", code: "audit-skipped", file: manifestsWithDepChanges[0], message: "npm audit failed to run; audit skipped" });
      }
    } else {
      findings.push({ severity: "info", code: "audit-skipped", file: manifestsWithDepChanges[0], message: "npm audit unavailable; audit skipped" });
    }
  }

  const high = findings.filter((f) => f.severity === "high").length;
  const medium = findings.filter((f) => f.severity === "medium").length;
  const status: DepCheckResult["status"] = !relevant ? "skipped" : high > 0 ? "failed" : "passed";
  const summary = !relevant
    ? "No dependency files changed"
    : findings.length === 0
      ? "Dependency changes look clean"
      : `${high} high, ${medium} medium: ${findings
          .filter((f) => f.severity === "high" || f.severity === "medium")
          .slice(0, 3)
          .map((f) => f.message)
          .join("; ")}`.slice(0, 500);
  return { status, high, findings, summary };
}

/** One-paragraph warning for the approval card, or null when nothing medium or worse was found. */
export function dependencyWarning(result: DepCheckResult): string | null {
  const serious = result.findings.filter((f) => f.severity === "high" || f.severity === "medium");
  if (serious.length === 0) return null;
  const lines = serious.slice(0, 6).map((f) => `- [${f.severity}] ${f.file}: ${f.message}`);
  if (serious.length > 6) lines.push(`- … ${serious.length - 6} more`);
  return `Dependency check: ${result.high > 0 ? "high-risk changes, review before approving" : "changes to review"}\n${lines.join("\n")}`;
}

/** Minimal git runner (tools/gitPush ExecGit shape). */
type GitRunner = (args: string[]) => Promise<{ stdout: string }>;

const DEP_FILE = (p: string) => path.posix.basename(p) === "package.json" || LOCKFILES.includes(path.posix.basename(p)) || CI_FILE.test(p);

/**
 * The dependency check for a pushed commit against its base branch
 * (`origin/<base>` or `<base>`, merge-base diff). Any git problem → "skipped"
 * with the reason; it never fails the push.
 */
export async function checkCommitDependencies(git: GitRunner, input: { commitSha: string; baseBranch: string }, opts: Omit<DepCheckOptions, "fileExists"> = {}): Promise<DepCheckResult> {
  const skipped = (summary: string): DepCheckResult => ({ status: "skipped", high: 0, findings: [], summary });
  try {
    let base: string | null = null;
    for (const ref of [`refs/remotes/origin/${input.baseBranch}`, `refs/heads/${input.baseBranch}`]) {
      try {
        base = (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).stdout.trim() || null;
      } catch {
        base = null;
      }
      if (base) break;
    }
    if (!base) return skipped(`base branch ${input.baseBranch} is not available locally`);
    const mergeBase = (await git(["merge-base", base, input.commitSha])).stdout.trim();
    if (!mergeBase) return skipped("no merge base with the base branch");
    const listed = (await git(["diff", "--name-status", "--no-renames", "-z", mergeBase, input.commitSha])).stdout.split("\0").filter(Boolean);
    const changes: DepFileChange[] = [];
    for (let i = 0; i + 1 < listed.length; i += 2) {
      const status = listed[i];
      const file = listed[i + 1];
      if (!DEP_FILE(file)) continue;
      const changeType: DepFileChange["changeType"] = status.startsWith("A") ? "new" : status.startsWith("D") ? "deleted" : "modified";
      const isLock = LOCKFILES.includes(path.posix.basename(file));
      const show = async (rev: string) => (isLock ? "" : (await git(["show", `${rev}:${file}`])).stdout);
      changes.push({
        filePath: file,
        changeType,
        ...(changeType !== "new" ? { oldContent: await show(mergeBase) } : {}),
        ...(changeType !== "deleted" ? { newContent: await show(input.commitSha) } : {}),
      });
    }
    if (changes.length === 0) return skipped("No dependency files changed");
    // Lockfiles that exist at the commit, near each changed manifest.
    const candidates = new Set<string>();
    for (const c of changes) {
      if (path.posix.basename(c.filePath) !== "package.json") continue;
      let dir = path.posix.dirname(c.filePath);
      for (;;) {
        for (const lock of LOCKFILES) candidates.add(dir === "." ? lock : `${dir}/${lock}`);
        if (dir === "." || dir === "") break;
        dir = path.posix.dirname(dir);
      }
    }
    const present = new Set(
      candidates.size > 0
        ? (await git(["ls-tree", "--name-only", input.commitSha, "--", ...candidates])).stdout.split("\n").map((s) => s.trim()).filter(Boolean)
        : []
    );
    return await checkDependencyChanges(changes, { ...opts, fileExists: (p) => present.has(p) });
  } catch (error) {
    return skipped(`dependency check could not read the diff: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`);
  }
}
