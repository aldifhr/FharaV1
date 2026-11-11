/**
 * Post-answer check for grounded chat replies: every file path and
 * file:line reference in the answer must have been seen in a tool result
 * this reply (or, for a bare path, in the repo snapshot). Whatever was not
 * seen is reported back as "Unverified: …" under the bubble, so an invented
 * `roleRegistry.ts:58` is visible as such instead of reading like a fact.
 *
 * Pure: no Convex or Node APIs.
 */

/** What the tool results of one reply showed. */
export interface RepoEvidence {
  /** Raw text of every tool call description and result the model saw. */
  corpus: string;
  /** Repo-relative file → line numbers shown (grep matches, read_file lines). */
  lines: Map<string, Set<number>>;
}

const CODE_EXT = "ts|tsx|js|jsx|mjs|cjs|json|md|mdx|py|go|rs|css|scss|html|yml|yaml|toml|sql|sh|prisma|graphql";

/** Bare names that are product names, not files. */
const NOT_FILES = new Set([
  "node.js",
  "next.js",
  "nuxt.js",
  "vue.js",
  "react.js",
  "express.js",
  "three.js",
  "d3.js",
  "chart.js",
  "nest.js",
  "deno.js",
  "bun.js",
  "convex.js",
]);

/** Build the evidence set from the tool results of one reply. */
export function collectRepoEvidence(results: Array<{ label?: string; text: string; files?: string[] }>): RepoEvidence {
  const lines = new Map<string, Set<number>>();
  const add = (file: string, line: number) => {
    if (!file || !Number.isFinite(line)) return;
    const set = lines.get(file) ?? new Set<number>();
    set.add(line);
    lines.set(file, set);
  };
  const corpus: string[] = [];
  for (const r of results) {
    if (r.label) corpus.push(r.label);
    corpus.push(r.text);
    for (const f of r.files ?? []) corpus.push(f);
    // grep: "path:12: text"
    for (const m of r.text.matchAll(/^([^\s:]+):(\d+): /gm)) add(m[1], Number(m[2]));
    // read_file: header "path: N bytes, …" then numbered lines "12: text"
    const header = /^([^\s:]+): \d+ bytes/m.exec(r.text);
    const readFile = r.files?.[0] ?? header?.[1];
    if (readFile) {
      for (const m of r.text.matchAll(/^(\d+): /gm)) add(readFile, Number(m[1]));
    }
  }
  return { corpus: corpus.join("\n"), lines };
}

export interface FileRef {
  /** As written in the answer, e.g. `apps/api/convex/chat.ts:412`. */
  ref: string;
  path: string;
  line?: number;
}

/** File paths and file:line references written in an answer. */
export function extractFileRefs(answer: string): FileRef[] {
  const refs: FileRef[] = [];
  const seen = new Set<string>();
  const pattern = new RegExp(
    String.raw`(?<![\w/.@:-])((?:[\w@.-]+/)*[\w@-][\w@.-]*\.(?:${CODE_EXT}))(?![\w/-])` +
      String.raw`(?:(?::(\d+)(?:[-–]\d+)?)|(?:#L(\d+))|(?:,?\s*\(?\s*(?:line|lines|baris|L)\s*(\d+)))?`,
    "gi"
  );
  for (const m of answer.matchAll(pattern)) {
    const path = m[1].replace(/^\.\//, "");
    const lineText = m[2] ?? m[3] ?? m[4];
    const line = lineText ? Number(lineText) : undefined;
    if (!path.includes("/") && line === undefined && NOT_FILES.has(path.toLowerCase())) continue;
    // A dotted identifier like `ctx.db.query` is not a file; require a code
    // extension at the end (enforced by the regex) and no leading dot.
    if (path.startsWith(".")) continue;
    const ref = line !== undefined ? `${path}:${line}` : path;
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push({ ref, path, line });
  }
  return refs;
}

/** Evidence keys that name the same file as `path` (exact, or one is a path suffix of the other). */
function sameFileKeys(evidence: RepoEvidence, path: string): string[] {
  const keys: string[] = [];
  for (const key of evidence.lines.keys()) {
    if (key === path || key.endsWith(`/${path}`) || path.endsWith(`/${key}`)) keys.push(key);
  }
  return keys;
}

function pathSeen(path: string, evidence: RepoEvidence, snapshot: string | null | undefined): boolean {
  if (evidence.corpus.includes(path)) return true;
  if (sameFileKeys(evidence, path).length > 0) return true;
  const base = path.split("/").pop() ?? path;
  // The snapshot is an indented tree of names, so only the file name can be matched there.
  if (snapshot && new RegExp(String.raw`(^|\s)${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\s|\(|$)`, "m").test(snapshot)) {
    return true;
  }
  // A bare name ("schema.ts") seen as the end of a full path in a result.
  if (!path.includes("/") && new RegExp(String.raw`/${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\b`).test(evidence.corpus)) {
    return true;
  }
  return false;
}

function lineSeen(path: string, line: number, evidence: RepoEvidence): boolean {
  return sameFileKeys(evidence, path).some((key) => evidence.lines.get(key)?.has(line));
}

/**
 * References in the answer that no tool result this reply showed: a path
 * never seen, or a file:line whose line was never shown for that file.
 */
export function findUnverifiedRefs(
  answer: string,
  evidence: RepoEvidence,
  snapshot?: string | null,
  max = 8,
  /** The user's message: a file it names is the request ("buatkan bold.html"), not a claim. */
  request = ""
): string[] {
  const out: string[] = [];
  const requested = new Set(extractFileRefs(request).map((r) => r.path.split("/").pop()?.toLowerCase()));
  for (const ref of extractFileRefs(answer)) {
    if (ref.line === undefined && requested.has(ref.path.split("/").pop()?.toLowerCase())) continue;
    const ok = ref.line !== undefined ? lineSeen(ref.path, ref.line, evidence) : pathSeen(ref.path, evidence, snapshot);
    if (!ok) out.push(ref.ref);
    if (out.length >= max) break;
  }
  return out;
}

export const EMPTY_EVIDENCE: RepoEvidence = { corpus: "", lines: new Map() };
