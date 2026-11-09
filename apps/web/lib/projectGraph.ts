/**
 * Project Intelligence Graph (frontend only).
 *
 * Pure derivation over a project's source files: the file list plus the
 * contents the browser already fetched via `/api/project-files`. Edges come
 * from static `import` / `export … from` / dynamic `import()` / `require()`
 * specifiers resolved against the file tree (relative, `@/` alias, index).
 *
 * This is a *static* map for orientation: it tells the CTO where the entry
 * points, the critical paths and the change impact are, without reading
 * the whole repository on every task. It never runs the code.
 */

export interface PgFile {
  path: string;
  content?: string;
}

export type PgKind = "component" | "api" | "lib" | "config" | "test" | "other";

export interface PgNode {
  id: string;
  path: string;
  basename: string;
  kind: PgKind;
  /** Top-level folder, for grouping. */
  folder: string;
  isEntry: boolean;
  /** Fan-in × fan-out reach score (higher = more critical). */
  criticalScore: number;
}

export interface PgEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface PgGraph {
  nodes: PgNode[];
  edges: PgEdge[];
  entryPoints: string[];
  criticalPaths: Array<{ path: string; score: number }>;
  /** Unresolved relative imports (specifier, no matching file). */
  unresolved: string[];
  scannedFiles: number;
}

export function kindOf(filePath: string): PgKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".test.ts") || lower.endsWith(".test.tsx") || lower.endsWith(".spec.ts") || lower.endsWith(".spec.tsx")) return "test";
  if (/(^|\/)(route|api)\.(ts|tsx|js|jsx)$/.test(lower) || lower.includes("/api/")) return "api";
  if (/(^|\/)(app|pages|components)\//.test(lower)) return "component";
  if (/(^|\/)(lib|utils|hooks|services|components|store)/.test(lower)) return "lib";
  if (/\.(json|yaml|yml|toml|env)$/.test(lower)) return "config";
  return "other";
}

export function folderOf(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 1) return "(root)";
  return parts[0];
}

const ENTRY_BASENAMES = new Set([
  "page.tsx",
  "page.jsx",
  "layout.tsx",
  "layout.jsx",
  "route.ts",
  "route.jsx",
  "route.js",
  "index.ts",
  "index.tsx",
  "index.js",
  "index.jsx",
  "main.ts",
  "main.tsx",
  "app.tsx",
  "app.jsx",
  "server.ts",
  "server.js",
  "index.html",
  "app/page.tsx",
]);

export function isEntryPoint(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? "";
  return ENTRY_BASENAMES.has(base) || filePath === "app/page.tsx";
}

const IMPORT_RE =
  /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+(?:\*|\{[^}]*\})\s+from\s+|import\s*\(\s*)["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;

export function parseSpecifiers(content: string): string[] {
  const out: string[] = [];
  for (const match of content.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2];
    if (spec) out.push(spec);
  }
  return out;
}

const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".json", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

function resolveSpecifier(spec: string, fromPath: string, fileSet: Set<string>): string | null {
  let candidate: string | null = null;
  if (spec.startsWith(".")) {
    const dir = fromPath.split("/").slice(0, -1).join("/");
    candidate = [dir, spec].filter(Boolean).join("/").replace(/\/+/g, "/");
  } else if (spec.startsWith("@/")) {
    candidate = spec.slice(2);
  }
  if (!candidate || candidate.startsWith("node_modules") || candidate.startsWith("../")) return null;
  for (const ext of RESOLVE_EXTS) {
    const attempt = candidate + ext;
    if (fileSet.has(attempt)) return attempt;
  }
  return null;
}

/** Transitive reach (dependencies, one hop per level). */
function reach(start: string, next: (id: string) => string[], maxDepth = 8): Set<string> {
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const found: string[] = [];
    for (const id of frontier) {
      for (const target of next(id)) {
        if (!seen.has(target)) {
          seen.add(target);
          found.push(target);
        }
      }
    }
    frontier = found;
  }
  seen.delete(start);
  return seen;
}

export function buildGraph(files: PgFile[]): PgGraph {
  const fileSet = new Set(files.map((f) => f.path));
  const edges: PgEdge[] = [];
  const unresolved: string[] = [];
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const file of files) {
    outgoing.set(file.path, new Set());
    incoming.set(file.path, new Set());
  }
  for (const file of files) {
    if (!file.content) continue;
    for (const spec of parseSpecifiers(file.content)) {
      if (!spec.startsWith(".") && !spec.startsWith("@/")) continue;
      const target = resolveSpecifier(spec, file.path, fileSet);
      if (!target || target === file.path) {
        if (!target && spec.startsWith(".")) unresolved.push(`${file.path} → ${spec}`);
        continue;
      }
      const key = `${file.path}→${target}`;
      outgoing.get(file.path)?.add(target);
      incoming.get(target)?.add(file.path);
      if (!edges.some((e) => e.id === key)) edges.push({ id: key, from: file.path, to: target, label: spec });
    }
  }

  const nodes: PgNode[] = files.map((file) => {
    const deps = reach(file.path, (id) => [...(outgoing.get(id) ?? [])]);
    const dependents = reach(file.path, (id) => [...(incoming.get(id) ?? [])]);
    return {
      id: file.path,
      path: file.path,
      basename: file.path.split("/").pop() ?? file.path,
      kind: kindOf(file.path),
      folder: folderOf(file.path),
      isEntry: isEntryPoint(file.path),
      criticalScore: (incoming.get(file.path)?.size ?? 0) + deps.size + dependents.size,
    };
  });

  const entryPoints = nodes.filter((n) => n.isEntry).map((n) => n.path);
  const criticalPaths = [...nodes]
    .sort((a, b) => b.criticalScore - a.criticalScore)
    .slice(0, 8)
    .map((n) => ({ path: n.path, score: n.criticalScore }));

  return { nodes, edges, entryPoints, criticalPaths, unresolved: [...new Set(unresolved)].slice(0, 40), scannedFiles: files.length };
}

/** What breaks if `path` changes: everything that (transitively) imports it. */
export function impactOf(graph: PgGraph, path: string): string[] {
  const incoming = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const list = incoming.get(edge.to) ?? new Set<string>();
    list.add(edge.from);
    incoming.set(edge.to, list);
  }
  return [...reach(path, (id) => [...(incoming.get(id) ?? [])])].sort();
}

/** What `path` needs: everything it (transitively) imports. */
export function dependenciesOf(graph: PgGraph, path: string): string[] {
  const outgoing = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? new Set<string>();
    list.add(edge.to);
    outgoing.set(edge.from, list);
  }
  return [...reach(path, (id) => [...(outgoing.get(id) ?? [])])].sort();
}
