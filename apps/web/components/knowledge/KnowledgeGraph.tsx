"use client";

/**
 * Knowledge Graph (frontend only): projects, tasks, agents, files and
 * decisions on one canvas. Membership edges come from the real queries;
 * the two highlighted link styles are client-side inference (shared file
 * paths, shared keywords between tasks of different projects) plus the
 * recorded collaboration edges between roles.
 *
 * It is a view, not a permission boundary: the backend still decides who
 * may see what.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { Bot, CheckSquare, Download, File, Folder, Network, Pin, Search, X } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { buildGraph, neighbours, type KgEdge, type KgKind, type KgNode } from "@/lib/knowledgeGraph";
import { useToast } from "../Toasts";

const NODE_W = 236;
const NODE_H = 64;
const COL_GAP = 320;
const ROW_GAP = 16;
const PAD = 32;
const VIEW_H = 640;

const KIND_ORDER: KgKind[] = ["project", "task", "agent", "file", "memory"];
const KIND_META: Record<KgKind, { label: string; chip: string; bar: string; icon: typeof Folder }> = {
  project: { label: "Project", chip: "bg-sky-500/10 text-sky-700 ring-sky-500/20 dark:bg-sky-500/20 dark:text-sky-300", bar: "bg-sky-500", icon: Folder },
  task: { label: "Task", chip: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:bg-emerald-500/20 dark:text-emerald-300", bar: "bg-emerald-500", icon: CheckSquare },
  agent: { label: "Agent", chip: "bg-violet-500/10 text-violet-700 ring-violet-500/20 dark:bg-violet-500/20 dark:text-violet-300", bar: "bg-violet-500", icon: Bot },
  file: { label: "File", chip: "bg-amber-500/10 text-amber-800 ring-amber-500/20 dark:bg-amber-500/20 dark:text-amber-300", bar: "bg-amber-500", icon: File },
  memory: { label: "Decision", chip: "bg-pink-500/10 text-pink-700 ring-pink-500/20 dark:bg-pink-500/20 dark:text-pink-300", bar: "bg-pink-500", icon: Pin },
};

interface Box {
  key: string;
  node: KgNode;
  x: number;
  y: number;
}

function layoutGraph(nodes: KgNode[]): { boxes: Box[]; width: number; height: number } {
  const boxes: Box[] = [];
  const columns = new Map<KgKind, KgNode[]>();
  for (const node of nodes) {
    const list = columns.get(node.kind) ?? [];
    list.push(node);
    columns.set(node.kind, list);
  }
  let height = 0;
  KIND_ORDER.forEach((kind, col) => {
    const list = columns.get(kind) ?? [];
    list.forEach((node, row) => {
      boxes.push({ key: node.id, node, x: PAD + col * COL_GAP, y: PAD + row * (NODE_H + ROW_GAP) });
    });
    height = Math.max(height, list.length * (NODE_H + ROW_GAP));
  });
  return { boxes, width: PAD * 2 + (KIND_ORDER.length - 1) * COL_GAP + NODE_W, height: height + PAD * 2 };
}

function edgeEnds(a: Box, b: Box): { x1: number; y1: number; x2: number; y2: number } {
  // Right-edge → left-edge for forward edges, centre → centre otherwise.
  if (b.x > a.x) return { x1: a.x + NODE_W, y1: a.y + NODE_H / 2, x2: b.x, y2: b.y + NODE_H / 2 };
  if (b.x < a.x) return { x1: a.x, y1: a.y + NODE_H / 2, x2: b.x + NODE_W, y2: b.y + NODE_H / 2 };
  return { x1: a.x + NODE_W / 2, y1: a.y + NODE_H, x2: b.x + NODE_W / 2, y2: b.y };
}

export default function KnowledgeGraph() {
  const toast = useToast();
  const projects = useQuery(api.projects.list, {}) as Array<{ _id: string; name: string }> | undefined;
  const search = useQuery(api.search.global, { q: "" }) as
    | { projects: Array<{ _id: string; name: string }>; tasks: any[]; agents: any[] }
    | undefined;
  const agents = useQuery(api.agents.list, {}) as Array<{ _id: string; name: string; role: string; isEnabled?: boolean }> | undefined;
  const collab = useQuery(api.orgIntel.collaboration, { sinceDays: 90 }) as { nodes: Array<{ key: string; label: string }>; edges: Array<{ from: string; to: string; total: number }> } | undefined;

  const [projectId, setProjectId] = useState<string>("");
  const [crossProject, setCrossProject] = useState(true);
  const [kinds, setKinds] = useState<Record<KgKind, boolean>>({ project: true, task: true, agent: true, file: true, memory: true });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const selectedId = projectId || projects?.[0]?._id || null;
  const projectTasks = useQuery(api.tasks.listByProject, selectedId ? { projectId: selectedId as never } : "skip");
  const projectSubtasks = useQuery(api.workspace.listSubtasksByProject, selectedId ? { projectId: selectedId as never } : "skip");
  const projectFiles = useQuery(api.fileChanges.listByProject, selectedId ? { projectId: selectedId as never } : "skip");
  const sharedMemories = useQuery(api.memories.list, { scope: "shared" });
  const projectMemories = useQuery(
    api.memories.list,
    selectedId ? { scope: "project", projectId: selectedId as never } : "skip",
  );

  const subtasksFlat = useMemo(
    () => ((projectSubtasks as Array<{ subtasks: any[] }> | undefined) ?? []).flatMap((entry) => entry.subtasks),
    [projectSubtasks],
  );

  const selectedName = projects?.find((p) => p._id === selectedId)?.name;

  const graph = useMemo(() => {
    if (!projects || !search || !agents || !collab) return null;
    const collabLabels: Record<string, string> = {};
    for (const node of collab.nodes) collabLabels[node.key] = node.label;
    const built = buildGraph({
      projects,
      selectedProjectId: crossProject ? null : selectedId,
      searchTasks: search.tasks,
      projectTasks: (projectTasks ?? []) as any[],
      subtasks: subtasksFlat as any[],
      files: (projectFiles ?? []) as any[],
      agents,
      memories: [...(sharedMemories ?? []), ...(projectMemories ?? [])] as any[],
      collabEdges: collab.edges,
      collabLabels,
    });
    // Local type filter + search filter.
    const q = query.trim().toLowerCase();
    const visibleNodes = built.nodes.filter(
      (node) => kinds[node.kind] && (!q || node.label.toLowerCase().includes(q) || (node.sublabel ?? "").toLowerCase().includes(q)),
    );
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    const visibleEdges = built.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
    return { nodes: visibleNodes, edges: visibleEdges, truncated: built.truncated, totalNodes: built.nodes.length, totalEdges: built.edges.length };
  }, [
    projects,
    search,
    agents,
    collab,
    crossProject,
    selectedId,
    projectTasks,
    subtasksFlat,
    projectFiles,
    sharedMemories,
    projectMemories,
    kinds,
    query,
  ]);

  const laid = useMemo(() => (graph ? layoutGraph(graph.nodes) : null), [graph]);
  const boxes = useMemo(() => new Map(laid?.boxes.map((box) => [box.key, box])), [laid]);

  const crossLinks = graph?.edges.filter((e) => e.kind === "similar-task").length ?? 0;
  const selectedNode = selected ? graph?.nodes.find((n) => n.id === selected) : undefined;
  const selectedNeighbours = selected && graph ? neighbours({ nodes: graph.nodes, edges: graph.edges, truncated: [] }, selected) : [];

  // Pan (drag empty area, clamped both axes).
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const viewRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const recenter = useCallback(() => {
    const view = viewRef.current;
    if (!view || !laid) return;
    setOffset({ x: Math.max(0, Math.round((view.clientWidth - laid.width) / 2)), y: PAD });
  }, [laid]);

  useEffect(() => {
    const clamp = (x: number, y: number) => {
      const view = viewRef.current;
      if (!view || !laid) return { x, y };
      return {
        x: Math.min(PAD, Math.max(view.clientWidth - laid.width - PAD, x)),
        y: Math.min(PAD, Math.max(VIEW_H - laid.height - PAD, y)),
      };
    };
    const onMove = (event: PointerEvent) => {
      if (!panRef.current) return;
      const { startX, startY, ox, oy } = panRef.current;
      setOffset(clamp(ox + (event.clientX - startX), oy + (event.clientY - startY)));
    };
    const onUp = () => {
      panRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [laid]);

  useEffect(() => {
    if (laid) recenter();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph?.nodes.length]);

  const exportGraph = () => {
    if (!graph) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ nodes: graph.nodes, edges: graph.edges }, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "knowledge-graph.json";
    anchor.click();
    URL.revokeObjectURL(url);
    toast("success", "Exported", `${graph.nodes.length} nodes, ${graph.edges.length} edges.`);
  };

  const loading = !projects || !search || !agents || !collab || !graph || !laid;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-3">
        <h1 className="flex items-center gap-2 text-[16px] font-semibold">
          <Network size={17} /> Knowledge Graph
        </h1>
        <span className="text-[12px] text-ink-3">
          {graph ? `${graph.nodes.length}/${graph.totalNodes} nodes · ${graph.edges.length}/${graph.totalEdges} edges · ${crossLinks} cross-project links` : "Loading…"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
            Project
            <select
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setSelected(null);
              }}
              aria-label="Project"
              className="rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[13px] text-ink outline-none"
            >
              <option value="">All (first)</option>
              {projects?.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[13px] text-ink-2" title="View only — backend access still applies">
            <input type="checkbox" checked={crossProject} onChange={(event) => setCrossProject(event.target.checked)} className="h-4 w-4 accent-current" />
            Cross-project
          </label>
          <label className="relative flex items-center">
            <Search size={14} className="pointer-events-none absolute left-2.5 text-ink-3" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter nodes…"
              aria-label="Filter graph nodes"
              className="w-44 rounded-lg border border-line bg-canvas py-1.5 pl-8 pr-2 text-[13px] text-ink outline-none placeholder:text-ink-3"
            />
          </label>
          <button type="button" onClick={exportGraph} disabled={!graph} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover disabled:opacity-50">
            <Download size={14} /> Export
          </button>
          <button type="button" onClick={recenter} disabled={!laid} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover disabled:opacity-50">
            Reset view
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-panel px-4 py-2" role="group" aria-label="Node types">
        {KIND_ORDER.map((kind) => {
          const meta = KIND_META[kind];
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={kinds[kind]}
              onClick={() => setKinds((cur) => ({ ...cur, [kind]: !cur[kind] }))}
              className={`rounded-lg px-2.5 py-1 text-[12.5px] outline-none transition ${kinds[kind] ? `font-medium ring-1 ${meta.chip}` : "text-ink-3 hover:text-ink"}`}
            >
              {meta.label}
            </button>
          );
        })}
        <span className="ml-2 text-[12px] text-ink-3">Solid = recorded link · dashed = inferred (shared keyword). Drag empty area to pan; click a node for details.</span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          ref={viewRef}
          role="region"
          aria-label="Knowledge graph canvas. Drag the empty area to pan; click a node for details."
          className="relative min-w-0 flex-1 cursor-grab overflow-hidden bg-canvas active:cursor-grabbing"
          style={{ height: VIEW_H }}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("[data-kgcard]")) return;
            panRef.current = { startX: event.clientX, startY: event.clientY, ox: offset.x, oy: offset.y };
          }}
        >
          {loading ? (
            <div className="flex h-full items-center justify-center text-[13px] text-ink-3">Loading graph…</div>
          ) : (
            <div className="absolute left-0 top-0" style={{ width: laid!.width, height: laid!.height, transform: `translate(${offset.x}px, ${offset.y}px)` }}>
              <svg className="absolute inset-0" width={laid!.width} height={laid!.height} aria-hidden="true">
                {graph!.edges.map((edge) => {
                  const a = boxes.get(edge.from);
                  const b = boxes.get(edge.to);
                  if (!a || !b) return null;
                  const ends = edgeEnds(a, b);
                  const inferred = edge.kind === "similar-task";
                  const highlighted = selected && (edge.from === selected || edge.to === selected);
                  return (
                    <g key={edge.id}>
                      <line
                        x1={ends.x1}
                        y1={ends.y1}
                        x2={ends.x2}
                        y2={ends.y2}
                        strokeWidth={highlighted ? 2 : 1.5}
                        strokeDasharray={inferred ? "5 3" : undefined}
                        className={
                          highlighted
                            ? "stroke-brand"
                            : inferred
                              ? "stroke-violet-400"
                              : edge.kind === "collaborates"
                                ? "stroke-ink-3"
                                : "stroke-line-strong"
                        }
                        opacity={selected && !highlighted ? 0.35 : 0.9}
                      />
                      {edge.label && (
                        <text
                          x={(ends.x1 + ends.x2) / 2}
                          y={(ends.y1 + ends.y2) / 2 - 4}
                          textAnchor="middle"
                          className="fill-ink-2 stroke-canvas"
                          strokeWidth={3}
                          paintOrder="stroke"
                          fontSize={10}
                        >
                          {edge.label}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
              {laid!.boxes.map((box) => {
                const meta = KIND_META[box.node.kind];
                const Icon = meta.icon;
                const active = selected === box.node.id;
                return (
                  <button
                    key={box.key}
                    type="button"
                    data-kgcard="1"
                    aria-label={`${meta.label}: ${box.node.label}`}
                    onClick={() => setSelected(active ? null : box.node.id)}
                    className={`absolute rounded-lg border bg-panel p-2 text-left shadow-sm outline-none transition focus-visible:ring-2 focus-visible:ring-brand/40 ${
                      active ? "border-brand ring-2 ring-brand/30" : "border-line hover:border-line-strong"
                    }`}
                    style={{ left: box.x, top: box.y, width: NODE_W, height: NODE_H }}
                  >
                    <span className={`block h-1 -mx-2 -mt-2 mb-1.5 rounded-t-lg ${meta.bar}`} aria-hidden="true" />
                    <span className="flex items-center gap-1.5">
                      <Icon size={13} className="shrink-0 text-ink-3" />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">{box.node.label}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-ink-3">{box.node.sublabel ?? meta.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-line bg-panel p-4 lg:block" aria-label="Node details">
          {selectedNode ? (
            <NodePanel
              node={selectedNode}
              neighbours={selectedNeighbours}
              onSelect={setSelected}
              onClose={() => setSelected(null)}
            />
          ) : (
            <div className="grid gap-2 text-[13px] text-ink-2">
              <p className="font-medium text-ink">No selection</p>
              <p>
                {selectedName ? `Showing ${selectedName} with cross-project inference. ` : ""}
                Example: a task using the keyword <span className="font-medium">auth</span> in one project links to an <span className="font-medium">auth</span> test
                task in another, only when Cross-project is on.
              </p>
              <p className="text-ink-3">
                Links from affiliation are recorded data; dashed links are inferred from shared keywords. Backend access rules still apply — this toggle only
                changes what is drawn.
              </p>
              {graph?.truncated.length ? <p className="text-ink-3">Capped: {graph.truncated.join("; ")}.</p> : null}
            </div>
          )}
        </aside>
      </div>

      {selectedNode && (
        <div className="border-t border-line bg-panel p-4 lg:hidden">
          <NodePanel node={selectedNode} neighbours={selectedNeighbours} onSelect={setSelected} onClose={() => setSelected(null)} />
        </div>
      )}
    </main>
  );
}

function NodePanel({
  node,
  neighbours,
  onSelect,
  onClose,
}: {
  node: KgNode;
  neighbours: Array<{ node: KgNode; edge: KgEdge }>;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const meta = KIND_META[node.kind];
  return (
    <div className="grid gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <meta.icon size={14} /> {node.label}
          </p>
          <span className={`mt-1 inline-flex rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ${meta.chip}`}>{meta.label}</span>
          {node.sublabel && <p className="mt-1 truncate text-[12px] text-ink-3">{node.sublabel}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close details" className="rounded-lg p-1.5 text-ink-3 hover:bg-hover">
          <X size={16} />
        </button>
      </div>
      {node.href && (
        <a href={node.href} className="self-start text-[13px] font-medium text-brand-ink hover:underline">
          Open in app →
        </a>
      )}
      <div>
        <p className="text-[12.5px] font-semibold text-ink-2">Connected ({neighbours.length})</p>
        {neighbours.length === 0 ? (
          <p className="mt-1 text-[12.5px] text-ink-3">No links for this node.</p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {neighbours.map(({ node: target, edge }) => (
              <li key={`${edge.id}:${target.id}`}>
                <button
                  type="button"
                  onClick={() => onSelect(target.id)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink-2 outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40"
                >
                  <span className="min-w-0 flex-1 truncate">{target.label}</span>
                  {edge.label && <span className="shrink-0 text-[11px] text-ink-3">{edge.label}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
