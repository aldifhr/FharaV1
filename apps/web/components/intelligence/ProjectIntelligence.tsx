"use client";

/**
 * Project Intelligence Graph (frontend only): the orchestrator's map of
 * the project — files, their import edges, entry points, critical paths
 * and change impact. Scanning reads the workspace through the existing
 * `/api/project-files` route; the graph is derived on the client
 * (`lib/projectGraph.ts`) and rendered as a force-directed Sigma canvas
 * (`SigmaFileGraph`): ForceAtlas2 layout, Louvain communities, size by
 * criticality. Nothing executes code.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "convex/react";
import { Crosshair, Download, FileCode, FolderTree, RefreshCw, ScanSearch, Search } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "../Toasts";
import { buildGraph, dependenciesOf, impactOf, type PgGraph, type PgKind, type PgNode } from "@/lib/projectGraph";
import type { ColorMode } from "./SigmaFileGraph";

const SigmaFileGraph = dynamic(() => import("./SigmaFileGraph"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-0 flex-1 items-center justify-center text-[13px] text-white/40" style={{ background: "#07070c" }}>
      Loading graph…
    </div>
  ),
});

const KIND_META: Record<PgKind, { label: string; bar: string }> = {
  component: { label: "Component", bar: "bg-emerald-500" },
  api: { label: "API route", bar: "bg-sky-500" },
  lib: { label: "Lib", bar: "bg-violet-500" },
  config: { label: "Config", bar: "bg-amber-500" },
  test: { label: "Test", bar: "bg-pink-500" },
  other: { label: "File", bar: "bg-gray-400" },
};

async function fetchFileList(workspacePath: string): Promise<string[]> {
  const res = await fetch(`/api/project-files?workspacePath=${encodeURIComponent(workspacePath)}`);
  const data = (await res.json().catch(() => ({}))) as { files?: string[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Couldn't list files");
  return data.files ?? [];
}

async function fetchContent(workspacePath: string, filePath: string): Promise<string | null> {
  const res = await fetch(`/api/project-files?workspacePath=${encodeURIComponent(workspacePath)}&filePath=${encodeURIComponent(filePath)}`);
  const data = (await res.json().catch(() => ({}))) as { content?: string; binary?: boolean };
  if (!res.ok || data.binary) return null;
  return data.content ?? null;
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

export default function ProjectIntelligence() {
  const toast = useToast();
  const projects = useQuery(api.projects.list, {}) as Array<{ _id: string; name: string; workspacePath: string }> | undefined;
  const [projectId, setProjectId] = useState("");
  const [graph, setGraph] = useState<PgGraph | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [colorMode, setColorMode] = useState<ColorMode>("community");
  const [resetSignal, setResetSignal] = useState(0);
  const [focusNode, setFocusNode] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [scanId, setScanId] = useState(0);

  const project = projects?.find((p) => p._id === projectId) ?? projects?.[0];
  const scannedRef = useRef(false);

  const scan = useCallback(async () => {
    if (!project) return;
    setScanning(true);
    setSelected(null);
    try {
      const all = await fetchFileList(project.workspacePath);
      const codeFiles = all.filter((f) => CODE_EXT.test(f));
      setScanProgress(`Contents 0/${codeFiles.length}`);
      const contents: Array<{ path: string; content?: string }> = [];
      const CHUNK = 25;
      for (let i = 0; i < codeFiles.length; i += CHUNK) {
        const batch = codeFiles.slice(i, i + CHUNK);
        const results = await Promise.all(batch.map((f) => fetchContent(project.workspacePath, f)));
        batch.forEach((f, j) => contents.push({ path: f, content: results[j] ?? undefined }));
        setScanProgress(`Contents ${Math.min(i + CHUNK, codeFiles.length)}/${codeFiles.length}`);
        if (i > 300) break;
      }
      const built = buildGraph(contents);
      setGraph(built);
      setScanId((id) => id + 1);
      toast("success", "Scan complete", `${built.scannedFiles} files · ${built.edges.length} imports`);
    } catch (err) {
      toast("error", "Scan failed", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setScanning(false);
      setScanProgress("");
    }
  }, [project, toast]);

  useEffect(() => {
    if (project && !scannedRef.current) {
      scannedRef.current = true;
      void scan();
    }
  }, [project, scan]);

  const selectedNode = selected ? graph?.nodes.find((n) => n.id === selected) : undefined;
  const deps = selected && graph ? dependenciesOf(graph, selected) : [];
  const impact = selected && graph ? impactOf(graph, selected) : [];

  const focusFirstMatch = () => {
    const q = query.trim().toLowerCase();
    if (!graph || !q) return;
    const match = graph.nodes.find((n) => n.path.toLowerCase().includes(q));
    if (match) {
      setFocusNode(match.id);
      setFocusNonce((n) => n + 1);
      setSelected(match.id);
    }
  };

  const exportGraph = () => {
    if (!graph) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${project?.name ?? "project"}-graph.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const entryNodes = graph?.nodes.filter((n) => n.isEntry) ?? [];

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-3">
        <h1 className="flex items-center gap-2 text-[16px] font-semibold">
          <FolderTree size={17} /> Project Intelligence
        </h1>
        <span className="text-[12px] text-ink-3">
          {graph ? `${graph.nodes.length} files · ${graph.edges.length} imports · ${graph.entryPoints.length} entry points` : "Not scanned yet"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
            Project
            <select
              value={project?._id ?? ""}
              onChange={(event) => {
                setProjectId(event.target.value);
                scannedRef.current = false;
                setGraph(null);
                setSelected(null);
              }}
              aria-label="Project"
              className="rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[13px] text-ink outline-none"
            >
              {projects?.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="relative flex items-center">
            <Search size={14} className="pointer-events-none absolute left-2.5 text-ink-3" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") focusFirstMatch();
              }}
              placeholder="Filter files… (Enter to focus)"
              aria-label="Filter graph files"
              className="w-52 rounded-lg border border-line bg-canvas py-1.5 pl-8 pr-2 text-[13px] text-ink outline-none placeholder:text-ink-3"
            />
          </label>
          <div className="flex items-center rounded-lg border border-line p-0.5" role="group" aria-label="Node color mode">
            <button
              type="button"
              aria-pressed={colorMode === "community"}
              onClick={() => setColorMode("community")}
              className={`rounded-md px-2 py-1 text-[12.5px] outline-none transition focus-visible:ring-2 focus-visible:ring-brand/40 ${
                colorMode === "community" ? "bg-brand-soft font-medium text-brand-ink" : "text-ink-2 hover:text-ink"
              }`}
            >
              Communities
            </button>
            <button
              type="button"
              aria-pressed={colorMode === "kind"}
              onClick={() => setColorMode("kind")}
              className={`rounded-md px-2 py-1 text-[12.5px] outline-none transition focus-visible:ring-2 focus-visible:ring-brand/40 ${
                colorMode === "kind" ? "bg-brand-soft font-medium text-brand-ink" : "text-ink-2 hover:text-ink"
              }`}
            >
              File kinds
            </button>
          </div>
          <button
            type="button"
            onClick={() => void scan()}
            disabled={scanning || !project}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-50"
          >
            <RefreshCw size={14} className={scanning ? "animate-spin" : ""} /> {scanning ? scanProgress || "Scanning…" : "Rescan"}
          </button>
          <button
            type="button"
            onClick={() => setResetSignal((s) => s + 1)}
            disabled={!graph}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover disabled:opacity-50"
          >
            <Crosshair size={14} /> Reset view
          </button>
          <button
            type="button"
            onClick={exportGraph}
            disabled={!graph}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover disabled:opacity-50"
          >
            <Download size={14} /> Export
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {graph ? (
          <SigmaFileGraph
            graph={graph}
            selected={selected}
            onSelect={setSelected}
            query={query}
            colorMode={colorMode}
            resetSignal={resetSignal}
            focusNode={focusNode}
            focusNonce={focusNonce}
            layoutKey={`${project?._id ?? "none"}:${scanId}`}
          />
        ) : (
          <div className="relative flex min-w-0 flex-1 items-center justify-center" style={{ background: "#07070c" }}>
            <div className="flex flex-col items-center justify-center gap-2 text-[13px] text-white/40">
              <ScanSearch size={20} />
              {scanning ? <span>{scanProgress || "Scanning…"}</span> : <span>Press Rescan to map this project's files and imports.</span>}
            </div>
          </div>
        )}

        <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-line bg-panel p-4 lg:block" aria-label="Graph details">
          {selectedNode ? (
            <FilePanel
              node={selectedNode}
              deps={deps}
              impact={impact}
              onSelect={setSelected}
              onClose={() => setSelected(null)}
            />
          ) : (
            <div className="grid gap-3 text-[13px] text-ink-2">
              <p className="font-medium text-ink">How to read this map</p>
              <p>
                Each dot is a file; a line means “imports”. Colors show Louvain communities (switch to File kinds in the toolbar). Bigger
                dots are more critical — more breaks when they change.
              </p>
              <p className="text-ink-3">Drag to pan, scroll to zoom, double-click a node to focus it. Click a community in the legend to filter.</p>
              <div>
                <p className="font-medium text-ink">Entry points ({entryNodes.length})</p>
                {entryNodes.length === 0 ? (
                  <p className="mt-1 text-ink-3">None detected (page/layout/route/index).</p>
                ) : (
                  <ul className="mt-1.5 space-y-1">
                    {entryNodes.slice(0, 12).map((node) => (
                      <li key={node.id}>
                        <button type="button" onClick={() => setSelected(node.id)} className="block w-full truncate rounded-lg px-2 py-1 text-left font-mono text-[12px] outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40">
                          {node.path}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="font-medium text-ink">Critical paths (most change-sensitive)</p>
                <ul className="mt-1.5 space-y-1">
                  {(graph?.criticalPaths ?? []).map((entry) => (
                    <li key={entry.path}>
                      <button type="button" onClick={() => setSelected(entry.path)} className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-left font-mono text-[12px] outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40">
                        <span className="min-w-0 flex-1 truncate">{entry.path}</span>
                        <span className="shrink-0 tabular-nums text-ink-3">{entry.score}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              {graph && graph.unresolved.length > 0 && (
                <p className="text-[11.5px] text-ink-3">{graph.unresolved.length} unresolved import(s) — shown in Export.</p>
              )}
            </div>
          )}
        </aside>
      </div>

      {selectedNode && (
        <div className="border-t border-line bg-panel p-4 lg:hidden">
          <FilePanel node={selectedNode} deps={deps} impact={impact} onSelect={setSelected} onClose={() => setSelected(null)} />
        </div>
      )}
    </main>
  );
}

function FilePanel({
  node,
  deps,
  impact,
  onSelect,
  onClose,
}: {
  node: PgNode;
  deps: string[];
  impact: string[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const meta = KIND_META[node.kind];
  return (
    <div className="grid gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[13px] font-semibold text-ink">{node.path}</p>
          <span className={`mt-1 inline-flex rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ${meta.bar} bg-hover text-ink-2`}>
            {meta.label}
          </span>
          {node.isEntry && <span className="ml-1.5 rounded bg-brand-soft px-1 text-[9.5px] font-semibold text-brand-ink">ENTRY POINT</span>}
          <p className="mt-1 text-[12px] text-ink-3">Criticality score: <span className="tabular-nums font-medium text-ink">{node.criticalScore}</span></p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close details" className="rounded-lg p-1.5 text-ink-3 hover:bg-hover">
          ✕
        </button>
      </div>
      <div>
        <p className="text-[12.5px] font-semibold text-ink-2">If this file changes, affected ({impact.length})</p>
        {impact.length === 0 ? (
          <p className="mt-1 text-[12.5px] text-ink-3">Nothing imports it transitively.</p>
        ) : (
          <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto">
            {impact.slice(0, 30).map((path) => (
              <li key={path}>
                <button type="button" onClick={() => onSelect(path)} className="block w-full truncate rounded px-1 py-0.5 text-left font-mono text-[11.5px] text-ink-2 outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40">
                  {path}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="text-[12.5px] font-semibold text-ink-2">This file depends on ({deps.length})</p>
        {deps.length === 0 ? (
          <p className="mt-1 text-[12.5px] text-ink-3">No local imports.</p>
        ) : (
          <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto">
            {deps.slice(0, 30).map((path) => (
              <li key={path}>
                <button type="button" onClick={() => onSelect(path)} className="block w-full truncate rounded px-1 py-0.5 text-left font-mono text-[11.5px] text-ink-2 outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40">
                  {path}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
