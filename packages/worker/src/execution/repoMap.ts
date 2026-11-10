// Ported from Aider (https://github.com/Aider-AI/aider, commit 5dc9490),
// aider/repomap.py lines 279-525 (get_tags_raw, get_ranked_tags) and the
// token-budgeted rendering of get_ranked_tags_map / to_tree.
// SPDX-License-Identifier: Apache-2.0. See THIRD_PARTY_NOTICES.md.
// Modified by Fhara: rewritten in TypeScript; tags come from the TypeScript compiler's
// parser (ts.createSourceFile) instead of tree-sitter tag queries, so only TS/JS files
// are mapped (other repositories fall back to the flat listing); networkx.pagerank is
// replaced by utils/pagerank.ts; self-references and unreferenced definitions stay out
// of the PageRank graph; package imports, locals and builtin names are not references;
// relative-import edges are added beside identifier edges; files are ordered by PageRank
// with their best definitions; the budget is in characters; the tag cache is a JSON file
// keyed by mtime+size.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as TS from "typescript";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import { pagerank, type WeightedGraph } from "@/utils/pagerank";
import { loadTypescript } from "./tsRuntime";

/**
 * Ranked repository map (multi-repo adoption R7, phase A): the files most
 * relevant to a request, each with its key definitions, inside a character
 * budget. Files link to the files whose identifiers they use; PageRank,
 * personalised by the files and identifiers the request names, orders them.
 */

export interface RepoMapOptions {
  /** The request / subtask text: identifiers and paths in it personalise the ranking. */
  query?: string;
  /** Workspace-relative files (or directories) the request names (fileHint, allowedPaths). */
  mentionedFiles?: ReadonlyArray<string>;
  /** Character budget for the rendered map (default REPO_MAP_MAX_CHARS or 4000, about 1k tokens). */
  maxChars?: number;
  /** At most this many source files are considered (default 2000). */
  maxFiles?: number;
  /** Stop parsing new files after this long; the cache keeps the progress (default 15000 ms). */
  maxParseMs?: number;
  /** Tag cache directory (default FHARA_CACHE_DIR or ~/.fhara/cache). */
  cacheDir?: string;
  /** Task cancellation: building stops (returns null) once it fires. */
  signal?: AbortSignal;
}

export interface RepoMapResult {
  map: string;
  /** Files in rank order (the map shows a prefix of them). */
  rankedFiles: string[];
  fileCount: number;
  fromCache: boolean;
}

interface Tag {
  name: string;
  line: number;
  text: string;
}

interface FileTags {
  mtimeMs: number;
  size: number;
  defs: Tag[];
  refs: Record<string, number>;
  imports: string[];
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/i;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "out", ".convex", ".turbo", "coverage", ".qa", "_generated", "vendor"]);
const MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_CHARS = 4_000;

/** REPO_MAP=0 turns the map off; REPO_MAP_MAX_CHARS sets the budget. */
export function repoMapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.REPO_MAP ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

export function repoMapMaxChars(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.REPO_MAP_MAX_CHARS);
  return Number.isFinite(value) && value >= 200 ? Math.floor(value) : DEFAULT_MAX_CHARS;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function listGitFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z"],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 30_000, windowsHide: true, encoding: "utf8", env: buildChildEnv({ GIT_TERMINAL_PROMPT: "0" }) },
      (error, stdout) => resolve(error ? null : String(stdout).split("\0").filter(Boolean))
    );
  });
}

async function walkFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > 5 || files.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".qa")) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute, depth + 1);
      else if (SOURCE.test(entry.name)) files.push(path.relative(root, absolute).replace(/\\/g, "/"));
    }
  }
  await visit(root, 0);
  return files;
}

async function sourceFiles(root: string, limit: number): Promise<string[]> {
  const listed = await listGitFiles(root);
  const files = (listed ?? (await walkFiles(root, limit * 2)))
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => SOURCE.test(file) && !/\.d\.[cm]?ts$/i.test(file) && !/\.min\.js$/i.test(file))
    .filter((file) => !file.split("/").some((part) => SKIP_DIRS.has(part)));
  return [...new Set(files)].sort().slice(0, limit);
}

// ---------------------------------------------------------------------------
// Tags (Aider get_tags_raw): definitions and references per file
// ---------------------------------------------------------------------------

function firstLine(source: TS.SourceFile, node: TS.Node): string {
  const text = source.text.slice(node.getStart(source), node.getEnd());
  const line = text.split(/\r?\n/)[0].trim().replace(/\s*\{\s*$/, "").trim();
  return line.length > 140 ? `${line.slice(0, 137)}...` : line;
}

/**
 * Method names of the standard library and common frameworks: `arr.push()`
 * or `res.render()` says nothing about which repository file it uses, and
 * without this list a repo method called `push` collects every array push.
 */
const GENERIC_MEMBERS = new Set(
  (
    "push pop shift unshift map filter reduce reduceRight forEach join split slice splice includes indexOf lastIndexOf find findIndex findLast some every sort reverse concat flat flatMap fill at keys values entries " +
    "get set has delete add clear size then catch finally toString toJSON valueOf trim trimStart trimEnd replace replaceAll match matchAll test exec search startsWith endsWith toLowerCase toUpperCase padStart padEnd repeat charAt charCodeAt codePointAt localeCompare normalize substring substr " +
    "log error warn info debug trace dir table time timeEnd assert render flush close open write read emit on off once addListener removeListener addEventListener removeEventListener dispatchEvent " +
    "resolve reject all allSettled race any call apply bind assign freeze create defineProperty getPrototypeOf parse stringify from of isArray now max min floor ceil round abs random sqrt pow " +
    "next send end abort run start stop pipe destroy unref ref setTimeout clearTimeout setInterval clearInterval toFixed toISOString getTime describe it test expect toBe toEqual toHaveBeenCalled mock fn spyOn " +
    "query mutation action handler withIndex eq order collect first unique take paginate insert patch db filter runQuery runMutation runAction"
  ).split(" ")
);

/** Global / lib type and value names: never a reference to a repository file. */
const BUILTIN_NAMES = (
  "Map Set WeakMap WeakSet Promise Array Record Partial Required Readonly ReadonlyArray ReadonlySet ReadonlyMap Pick Omit Exclude Extract NonNullable ReturnType Parameters Awaited InstanceType " +
  "Error TypeError RangeError Date Number String Object Boolean Symbol BigInt JSON Math RegExp Buffer URL URLSearchParams Response Request Headers AbortController AbortSignal TextEncoder TextDecoder " +
  "Uint8Array Float64Array Int32Array ArrayBuffer Intl React Function Iterable AsyncIterable Generator console require setTimeout clearTimeout setInterval clearInterval fetch structuredClone queueMicrotask"
).split(" ");

function referenceName(ts: typeof TS, node: TS.Node): TS.Identifier | null {
  const target = (expression: TS.Expression): TS.Identifier | null => {
    if (ts.isIdentifier(expression)) return expression;
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
      return GENERIC_MEMBERS.has(expression.name.text) ? null : expression.name;
    }
    return null;
  };
  if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.expression) return target(node.expression);
  if (ts.isTaggedTemplateExpression(node)) return target(node.tag);
  if (ts.isDecorator(node) && ts.isIdentifier(node.expression)) return node.expression;
  if (ts.isTypeReferenceNode(node)) return ts.isIdentifier(node.typeName) ? node.typeName : ts.isQualifiedName(node.typeName) ? node.typeName.right : null;
  if (ts.isExpressionWithTypeArguments(node)) return target(node.expression);
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    return ts.isIdentifier(node.tagName) && /^[A-Z]/.test(node.tagName.text) ? node.tagName : null;
  }
  if (ts.isImportSpecifier(node)) return node.propertyName && ts.isIdentifier(node.propertyName) ? node.propertyName : node.name;
  if (ts.isImportClause(node) && node.name) return node.name;
  if (ts.isExportSpecifier(node) && !(node.parent?.parent as TS.ExportDeclaration | undefined)?.moduleSpecifier) return null;
  return null;
}

function isInternalSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("~/") || specifier.startsWith("#") || specifier.startsWith("@api/");
}

export function extractTags(ts: typeof TS, filePath: string, content: string): Omit<FileTags, "mtimeMs" | "size"> {
  const kind = /\.tsx$/i.test(filePath) ? ts.ScriptKind.TSX : /\.[cm]?ts$/i.test(filePath) ? ts.ScriptKind.TS : ts.ScriptKind.JSX;
  const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, kind);
  const defs: Tag[] = [];
  const refs: Record<string, number> = Object.create(null) as Record<string, number>;
  const imports: string[] = [];
  const defNames = new Set<TS.Node>();
  /** Names declared in this file (locals, parameters, nested functions): a call to one is not a cross-file reference. */
  const locals = new Set<string>();

  const addDef = (nameNode: TS.Node | undefined, node: TS.Node) => {
    if (!nameNode || !ts.isIdentifier(nameNode)) return;
    defNames.add(nameNode);
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    defs.push({ name: nameNode.text, line: line + 1, text: firstLine(source, node) });
  };

  const visit = (node: TS.Node, depth: number) => {
    if (depth === 0 && (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node))) {
      addDef(node.name, node);
    } else if (depth === 1 && (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isGetAccessorDeclaration(node)) && ts.isClassLike(node.parent)) {
      addDef(node.name, node);
    } else if (ts.isVariableStatement(node) && depth === 0) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) addDef(declaration.name, node.declarationList.declarations.length === 1 ? node : declaration);
      }
    } else if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        imports.push(node.arguments[0].text);
      }
    }
    // References, like Aider's tags queries: call / new targets (also
    // `obj.method()`), type references, heritage clauses, JSX tags and
    // imported names. Plain property names and locals are not references.
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
      locals.add(node.name.text);
    }
    const ref = referenceName(ts, node);
    if (ref && !defNames.has(ref)) refs[ref.text] = (refs[ref.text] ?? 0) + 1;
    // Top-level statements (and those of a namespace) are depth 0; anything
    // inside a function body, block or class is local.
    const nextDepth = ts.isModuleBlock(node) ? depth : ts.isBlock(node) || ts.isClassLike(node) || ts.isFunctionLike(node) ? depth + 1 : depth;
    ts.forEachChild(node, (child) => visit(child, nextDepth));
  };
  ts.forEachChild(source, (child) => visit(child, 0));
  for (const name of locals) delete refs[name];
  for (const name of BUILTIN_NAMES) delete refs[name];
  // Names imported from packages (`import { render } from "@testing-library/react"`)
  // are not references to repository files.
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (isInternalSpecifier(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) delete refs[clause.name.text];
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        delete refs[element.name.text];
        if (element.propertyName && ts.isIdentifier(element.propertyName)) delete refs[element.propertyName.text];
      }
    }
  }
  return { defs, refs, imports };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface WorkspaceCache {
  tags: Map<string, FileTags>;
  results: Map<string, RepoMapResult>;
  dirty: boolean;
}

const memory = new Map<string, WorkspaceCache>();

function cacheDirFor(options: RepoMapOptions): string {
  return options.cacheDir ?? process.env.FHARA_CACHE_DIR ?? path.join(os.homedir(), ".fhara", "cache");
}

function cacheFile(dir: string, root: string): string {
  return path.join(dir, `repomap-${createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`);
}

async function loadCache(root: string, options: RepoMapOptions): Promise<WorkspaceCache> {
  const existing = memory.get(root);
  if (existing) return existing;
  const cache: WorkspaceCache = { tags: new Map(), results: new Map(), dirty: false };
  try {
    const raw = JSON.parse(await fs.readFile(cacheFile(cacheDirFor(options), root), "utf-8")) as { version?: number; files?: Record<string, FileTags> };
    if (raw.version === 1 && raw.files) for (const [file, tags] of Object.entries(raw.files)) cache.tags.set(file, tags);
  } catch {
    // No cache yet.
  }
  memory.set(root, cache);
  return cache;
}

async function saveCache(root: string, cache: WorkspaceCache, options: RepoMapOptions): Promise<void> {
  if (!cache.dirty) return;
  try {
    const dir = cacheDirFor(options);
    await fs.mkdir(dir, { recursive: true });
    const target = cacheFile(dir, root);
    const temp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ version: 1, files: Object.fromEntries(cache.tags) }));
    await fs.rename(temp, target);
    cache.dirty = false;
  } catch {
    // Best effort.
  }
}

// ---------------------------------------------------------------------------
// Ranking (Aider get_ranked_tags)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(["the", "and", "for", "fix", "add", "use", "new", "with", "from", "into", "that", "this", "not", "all", "src", "lib", "app", "make", "should", "when", "file", "files", "code", "yang", "dan", "untuk", "di", "ke"]);

/** Identifier-like words of a request (Aider get_ident_mentions). */
export function mentionedIdents(text: string): Set<string> {
  const words = new Set<string>();
  for (const word of (text ?? "").split(/[^A-Za-z0-9_$]+/)) {
    if (word.length < 3 || /^\d/.test(word) || STOPWORDS.has(word.toLowerCase())) continue;
    words.add(word);
  }
  return words;
}

function resolveImport(from: string, specifier: string, known: ReadonlySet<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const stripped = base.replace(/\.(?:[cm]?js|jsx)$/i, "");
  for (const candidate of [base, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].map((ext) => stripped + ext), ...["index.ts", "index.tsx", "index.js"].map((name) => `${base}/${name}`)]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

interface Ranked {
  /** (file, ident) definitions in rank order. */
  definitions: Array<{ file: string; ident: string; rank: number }>;
  fileRank: Map<string, number>;
}

function rank(tagsByFile: Map<string, FileTags>, mentionedFiles: ReadonlySet<string>, idents: ReadonlySet<string>): Ranked {
  const defines = new Map<string, Set<string>>();
  const references = new Map<string, Map<string, number>>();
  const files = [...tagsByFile.keys()].sort();
  const known = new Set(files);
  const personalization = new Map<string, number>();
  const personalize = 100 / Math.max(1, files.length);
  const lowerIdents = new Set([...idents].map((ident) => ident.toLowerCase()));

  for (const file of files) {
    const tags = tagsByFile.get(file)!;
    let pers = 0;
    if (mentionedFiles.has(file) || [...mentionedFiles].some((m) => m.endsWith("/") ? file.startsWith(m) : false)) pers += personalize;
    const parts = file.split("/");
    const baseName = parts[parts.length - 1];
    const stem = baseName.replace(/\.[^.]+$/, "");
    const components = new Set([...parts, baseName, stem].map((part) => part.toLowerCase()));
    if ([...components].some((component) => lowerIdents.has(component))) pers += personalize;
    if (pers > 0) personalization.set(file, pers);
    for (const def of tags.defs) {
      if (!defines.has(def.name)) defines.set(def.name, new Set());
      defines.get(def.name)!.add(file);
    }
    for (const [name, count] of Object.entries(tags.refs)) {
      if (!references.has(name)) references.set(name, new Map());
      references.get(name)!.set(file, (references.get(name)!.get(file) ?? 0) + count);
    }
  }

  // Edge list keyed by source → (target → [ident, weight][]).
  const edgeIdents = new Map<string, Array<{ target: string; ident: string; weight: number }>>();
  const graph: WeightedGraph = new Map();
  const addEdge = (source: string, target: string, ident: string, weight: number) => {
    if (!(weight > 0)) return;
    if (!graph.has(source)) graph.set(source, new Map());
    const row = graph.get(source)!;
    row.set(target, (row.get(target) ?? 0) + weight);
    if (!edgeIdents.has(source)) edgeIdents.set(source, []);
    edgeIdents.get(source)!.push({ target, ident, weight });
  };

  const unreferenced = new Map<string, string[]>();
  for (const [ident, definers] of defines) {
    const referencers = references.get(ident);
    if (!referencers || referencers.size === 0) {
      // Aider adds a 0.1 self-edge for a definition nobody references. In
      // the graph that turns a file whose definitions nobody uses into a
      // rank sink (it keeps everything it receives), so here those
      // definitions are kept aside and get a small share of their file's
      // rank after PageRank instead.
      for (const definer of definers) {
        if (!unreferenced.has(definer)) unreferenced.set(definer, []);
        unreferenced.get(definer)!.push(ident);
      }
      continue;
    }
    let mul = 1;
    const isSnake = ident.includes("_") && /[A-Za-z]/.test(ident);
    const isCamel = /[A-Z]/.test(ident) && /[a-z]/.test(ident);
    if (idents.has(ident)) mul *= 10;
    if ((isSnake || isCamel) && ident.length >= 8) mul *= 10;
    if (ident.startsWith("_")) mul *= 0.1;
    if (definers.size > 5) mul *= 0.1;
    for (const [referencer, count] of referencers) {
      for (const definer of definers) {
        // A file's references to its own definitions would make it a rank
        // sink; its own share is added after PageRank instead (below).
        if (referencer === definer) continue;
        addEdge(referencer, definer, ident, mul * Math.sqrt(count));
      }
    }
  }
  // Relative imports: a weaker structural edge beside the identifier edges.
  for (const file of files) {
    for (const specifier of tagsByFile.get(file)!.imports) {
      const target = resolveImport(file, specifier, known);
      if (target && target !== file) addEdge(file, target, "", 1);
    }
  }

  const nodes = new Set<string>([...graph.keys(), ...personalization.keys(), ...unreferenced.keys()]);
  for (const row of graph.values()) for (const target of row.keys()) nodes.add(target);
  const fileRank = pagerank(nodes, graph, personalization.size > 0 ? personalization : undefined);

  // Distribute each source's rank across its out edges (Aider ranked_definitions).
  const rankedDefinitions = new Map<string, number>();
  for (const [source, list] of edgeIdents) {
    const sourceRank = fileRank.get(source) ?? 0;
    const total = list.reduce((sum, edge) => sum + edge.weight, 0);
    if (total <= 0) continue;
    for (const edge of list) {
      if (!edge.ident) continue;
      const key = `${edge.target}\0${edge.ident}`;
      rankedDefinitions.set(key, (rankedDefinitions.get(key) ?? 0) + (sourceRank * edge.weight) / total);
    }
  }
  // Each file's own share: a part of its rank spread over its definitions
  // (referenced ones weigh more than the ones nobody uses), so a file the
  // request names, or one many files depend on, shows its own API.
  for (const [file, tags] of tagsByFile) {
    const own = fileRank.get(file);
    // (kept for the per-file definition order in orderedEntries)
    if (!own || tags.defs.length === 0) continue;
    const unused = new Set(unreferenced.get(file) ?? []);
    const weights = tags.defs.map((def) => (unused.has(def.name) ? 0.1 : 1));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    tags.defs.forEach((def, i) => {
      const key = `${file}\0${def.name}`;
      rankedDefinitions.set(key, (rankedDefinitions.get(key) ?? 0) + (own * 0.3 * weights[i]) / total);
    });
  }
  const definitions = [...rankedDefinitions.entries()]
    .map(([key, value]) => {
      const [file, ident] = key.split("\0");
      return { file, ident, rank: value };
    })
    .sort((a, b) => b.rank - a.rank || a.file.localeCompare(b.file) || a.ident.localeCompare(b.ident));
  return { definitions, fileRank };
}

// ---------------------------------------------------------------------------
// Rendering (Aider get_ranked_tags_map / to_tree, budgeted by characters)
// ---------------------------------------------------------------------------

type Entry = { file: string; tags: Tag[] };

const DEFS_PER_FILE = 8;

/**
 * Map entries, file-major: files by PageRank (the request's files and what
 * they depend on first), each with its best definitions (by definition
 * rank, at most DEFS_PER_FILE). Aider orders by definition rank alone; on
 * a large repository that lets a generic name (`render`, `push`) pull
 * unrelated files ahead of the files the request names.
 */
function orderedEntries(ranked: Ranked, tagsByFile: Map<string, FileTags>): { entries: Array<{ file: string; tag?: Tag }>; files: string[] } {
  const defRank = new Map<string, number>();
  for (const { file, ident, rank: value } of ranked.definitions) defRank.set(`${file}\0${ident}`, value);
  const files = [...ranked.fileRank.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([file]) => file);
  const entries: Array<{ file: string; tag?: Tag }> = [];
  for (const file of files) {
    const defs = (tagsByFile.get(file)?.defs ?? [])
      .map((tag) => ({ tag, score: defRank.get(`${file}\0${tag.name}`) ?? 0 }))
      .sort((a, b) => b.score - a.score || a.tag.line - b.tag.line)
      .slice(0, DEFS_PER_FILE);
    if (defs.length === 0) entries.push({ file });
    else for (const { tag } of defs) entries.push({ file, tag });
  }
  return { entries, files };
}

function render(entries: Array<{ file: string; tag?: Tag }>): string {
  const byFile = new Map<string, Entry>();
  for (const entry of entries) {
    if (!byFile.has(entry.file)) byFile.set(entry.file, { file: entry.file, tags: [] });
    if (entry.tag) byFile.get(entry.file)!.tags.push(entry.tag);
  }
  const out: string[] = [];
  for (const { file, tags } of byFile.values()) {
    if (tags.length === 0) {
      out.push(file);
      continue;
    }
    out.push(`${file}:`);
    let lastLine = 0;
    for (const tag of [...tags].sort((a, b) => a.line - b.line)) {
      if (lastLine > 0 && tag.line > lastLine + 1) out.push("⋮");
      out.push(`│${tag.text}`);
      lastLine = tag.line;
    }
  }
  return out.join("\n");
}

/** The largest prefix of ranked entries whose rendering fits the budget (binary search, like Aider). */
export function fitToBudget(entries: Array<{ file: string; tag?: Tag }>, maxChars: number): string {
  let low = 0;
  let high = entries.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const text = render(entries.slice(0, middle));
    if (text.length <= maxChars) {
      best = text;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build the ranked map for a workspace, or null when there is nothing to
 * map (no TS/JS files, the compiler cannot be loaded, the map is turned
 * off). Never throws.
 */
export async function buildRepoMap(workspacePath: string, options: RepoMapOptions = {}): Promise<RepoMapResult | null> {
  try {
    if (!repoMapEnabled() || options.signal?.aborted) return null;
    const ts = loadTypescript();
    if (!ts) return null;
    const root = path.resolve(workspacePath);
    // Never index a whole home / temp / filesystem root (a misconfigured project path).
    if ([path.parse(root).root, os.homedir(), os.tmpdir()].map((dir) => path.resolve(dir)).includes(root)) return null;
    const maxChars = options.maxChars ?? repoMapMaxChars();
    const maxFiles = options.maxFiles ?? 2_000;
    const files = await sourceFiles(root, maxFiles);
    if (files.length === 0) return null;

    const cache = await loadCache(root, options);
    const stats = await Promise.all(
      files.map(async (file) => {
        try {
          const stat = await fs.stat(path.join(root, file));
          return stat.isFile() ? { file, mtimeMs: stat.mtimeMs, size: stat.size } : null;
        } catch {
          return null;
        }
      })
    );
    const present = stats.filter((entry): entry is { file: string; mtimeMs: number; size: number } => entry !== null && entry.size <= MAX_FILE_BYTES);

    const mentionedFiles = new Set((options.mentionedFiles ?? []).map((file) => file.replace(/\\/g, "/").replace(/^\.\//, "")).filter(Boolean));
    const query = options.query ?? "";
    for (const match of query.matchAll(/[\w./@-]+\.(?:[cm]?[jt]sx?)\b/g)) mentionedFiles.add(match[0].replace(/^\.\//, ""));
    const idents = mentionedIdents(query);

    const stateKey = createHash("sha1")
      .update(present.map((entry) => `${entry.file}:${entry.mtimeMs}:${entry.size}`).join("\n"))
      .update("\0")
      .update([...mentionedFiles].sort().join("\n"))
      .update("\0")
      .update([...idents].sort().join(" "))
      .update(`\0${maxChars}`)
      .digest("hex");
    const hit = cache.results.get(stateKey);
    if (hit) return { ...hit, fromCache: true };

    const started = Date.now();
    const maxParseMs = options.maxParseMs ?? 15_000;
    const tagsByFile = new Map<string, FileTags>();
    let reused = 0;
    for (const entry of present) {
      const cached = cache.tags.get(entry.file);
      if (cached && cached.mtimeMs === entry.mtimeMs && cached.size === entry.size) {
        tagsByFile.set(entry.file, cached);
        reused += 1;
        continue;
      }
      if (Date.now() - started > maxParseMs) continue;
      // Parsing is synchronous: yield now and then so timers, deadlines
      // and cancellation still run while a large repository is indexed.
      if ((tagsByFile.size - reused) % 25 === 24) {
        await new Promise((resolve) => setImmediate(resolve));
        if (options.signal?.aborted) {
          await saveCache(root, cache, options);
          return null;
        }
      }
      try {
        const content = await fs.readFile(path.join(root, entry.file), "utf-8");
        const tags: FileTags = { mtimeMs: entry.mtimeMs, size: entry.size, ...extractTags(ts, entry.file, content) };
        cache.tags.set(entry.file, tags);
        cache.dirty = true;
        tagsByFile.set(entry.file, tags);
      } catch {
        // Unreadable: leave it out.
      }
    }
    // Drop cache entries for files that are gone.
    const live = new Set(present.map((entry) => entry.file));
    for (const file of [...cache.tags.keys()]) {
      if (!live.has(file)) {
        cache.tags.delete(file);
        cache.dirty = true;
      }
    }
    if (tagsByFile.size === 0) return null;

    const ranked = rank(tagsByFile, mentionedFiles, idents);
    const { entries, files: rankedFiles } = orderedEntries(ranked, tagsByFile);
    const map = fitToBudget(entries, maxChars);
    if (!map) return null;
    const result: RepoMapResult = { map, rankedFiles, fileCount: tagsByFile.size, fromCache: reused === tagsByFile.size };
    if (cache.results.size >= 16) cache.results.delete(cache.results.keys().next().value as string);
    cache.results.set(stateKey, result);
    await saveCache(root, cache, options);
    return result;
  } catch {
    return null;
  }
}

/** Forget the in-memory cache (tests). */
export function clearRepoMapMemory(): void {
  memory.clear();
}
