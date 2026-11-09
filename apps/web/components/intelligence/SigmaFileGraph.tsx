"use client";

/**
 * Force-directed project graph: the `PgGraph` built by `lib/projectGraph`
 * (files + import edges) rendered as an interactive Sigma.js canvas.
 *
 * Data path: PgGraph → graphology (undirected, deduped) → Louvain
 * communities (`graphology-communities-louvain`) → ForceAtlas2 layout in a
 * web worker (`@react-sigma/layout-forceatlas2`). The canvas is a full-bleed
 * dark scene in both app themes: bright community colors on nodes AND
 * translucent edges, node size by criticality, glow on hub nodes, white
 * labels on the big nodes. Selection, hover, search and community filtering
 * run through Sigma's node/edge reducers, keyed off a ref so the Sigma
 * instance is created once per page.
 *
 * This is a view only: scanning still runs through `/api/project-files`
 * (see ProjectIntelligence) and nothing here executes code.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import {
  ControlsContainer,
  SigmaContainer,
  ZoomControl,
  useCamera,
  useLoadGraph,
  useRegisterEvents,
  useSigma,
} from "@react-sigma/core";
import { useWorkerLayoutForceAtlas2 } from "@react-sigma/layout-forceatlas2";
import type { EdgeReducer, NodeReducer } from "sigma/types";
import { Pause, Play } from "lucide-react";
import type { PgGraph, PgKind } from "@/lib/projectGraph";

export type ColorMode = "community" | "kind";

const CANVAS_BG = "#07070c";
const BRAND = "#818cf8";
const LABEL_COLOR = "#f3f4f6";
const LABEL_BG = "rgba(7,7,12,0.55)";

const KIND_HEX: Record<PgKind, string> = {
  component: "#34d399",
  api: "#38bdf8",
  lib: "#a78bfa",
  config: "#fbbf24",
  test: "#f472b6",
  other: "#9ca3af",
};

const KIND_LABEL: Record<PgKind, string> = {
  component: "Component",
  api: "API route",
  lib: "Lib",
  config: "Config",
  test: "Test",
  other: "File",
};

// Vivid community palette, matching the Reference look: violet / pink / blue-dominant.
const COMMUNITY_PALETTE = [
  "#a78bfa",
  "#f472b6",
  "#38bdf8",
  "#34d399",
  "#fbbf24",
  "#fb923c",
  "#2dd4bf",
  "#f87171",
  "#a3e635",
  "#22d3ee",
  "#e879f9",
  "#60a5fa",
];

function communityColor(id: number): string {
  const n = COMMUNITY_PALETTE.length;
  return COMMUNITY_PALETTE[((id % n) + n) % n]!;
}

function withAlpha(hex: string, alpha: number): string {
  const hex6 = hex.replace("#", "").replace(/^([0-9a-f])([0-9a-f])([0-9a-f])$/, "$1$1$2$2$3$3");
  const n = parseInt(hex6, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

interface CommunityInfo {
  id: number;
  count: number;
  color: string;
}

interface ViewState {
  selected: string | null;
  hovered: string | null;
  query: string;
  colorMode: ColorMode;
  communityFilterId: number | null;
  neighbors: ReadonlySet<string>;
}

const EMPTY_NEIGHBORS: ReadonlySet<string> = new Set();

/**
 * Convert a PgGraph into a graphology graph: node size from criticality
 * (sqrt-scaled so hubs read much bigger than leaves, like the Reference),
 * initial positions on a deterministic golden-angle spiral (ForceAtlas2
 * takes over from there), undirected deduped import edges colored by their
 * source node's Louvain community, and a community id per node.
 */
function toGraphology(pg: PgGraph): { graph: Graph; communities: CommunityInfo[] } {
  const g = new Graph({ type: "undirected" });
  const maxScore = Math.max(1, ...pg.nodes.map((n) => n.criticalScore));
  pg.nodes.forEach((node, i) => {
    const angle = i * 2.399963229728653; // golden angle: even spiral, no randomness
    const radius = 14 * Math.sqrt(i);
    g.addNode(node.id, {
      label: node.basename,
      path: node.path,
      kind: node.kind,
      folder: node.folder,
      isEntry: node.isEntry,
      criticalScore: node.criticalScore,
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
      size: 4 + 18 * Math.sqrt(node.criticalScore / maxScore),
      color: KIND_HEX[node.kind],
    });
  });

  const seen = new Set<string>();
  for (const edge of pg.edges) {
    if (!g.hasNode(edge.from) || !g.hasNode(edge.to) || edge.from === edge.to) continue;
    const key = edge.from < edge.to ? `${edge.from}\n${edge.to}` : `${edge.to}\n${edge.from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    g.addEdge(edge.from, edge.to);
  }

  let mapping: Record<string, number> = {};
  if (g.size > 0) {
    try {
      mapping = louvain(g, { nodeCommunityAttribute: "community" }) ?? {};
    } catch {
      mapping = {};
    }
  }
  const counts = new Map<number, number>();
  for (const node of pg.nodes) {
    const community = typeof mapping[node.id] === "number" ? mapping[node.id] : 0;
    g.setNodeAttribute(node.id, "community", community);
    counts.set(community, (counts.get(community) ?? 0) + 1);
  }

  // Edge color = source community, translucent (the hairball reads multicolored).
  g.forEachEdge((edge, _attrs, source) => {
    const community = g.getNodeAttribute(source, "community") as number;
    g.setEdgeAttribute(edge, "color", withAlpha(communityColor(community), 0.45));
  });

  const communities = [...counts.entries()]
    .map(([id, count]) => ({ id, count, color: communityColor(id) }))
    .sort((a, b) => b.count - a.count || a.id - b.id);

  return { graph: g, communities };
}

interface LoaderProps {
  graph: Graph;
  layoutKey: string;
  resetSignal: number;
  focusNode: string | null;
  focusNonce: number;
  view: RefObject<ViewState>;
  selected: string | null;
  hovered: string | null;
  query: string;
  colorMode: ColorMode;
  communityFilterId: number | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
}

/** Loads the graphology graph into Sigma and wires pointer / camera behaviour. */
function GraphLoader({
  graph,
  layoutKey,
  resetSignal,
  focusNode,
  focusNonce,
  view,
  selected,
  hovered,
  query,
  colorMode,
  communityFilterId,
  onSelect,
  onHover,
}: LoaderProps) {
  const sigma = useSigma();
  const loadGraph = useLoadGraph();
  const registerEvents = useRegisterEvents();
  const { reset, gotoNode } = useCamera();

  useEffect(() => {
    loadGraph(graph);
  }, [graph, loadGraph]);

  // Keep the reducers' view in sync, then repaint.
  useEffect(() => {
    view.current = {
      selected,
      hovered,
      query,
      colorMode,
      communityFilterId,
      neighbors: selected ? new Set(graph.neighbors(selected)) : EMPTY_NEIGHBORS,
    };
    sigma.refresh();
  }, [graph, selected, hovered, query, colorMode, communityFilterId, sigma, view]);

  useEffect(() => {
    registerEvents({
      clickNode: ({ node }) => onSelect(node === selected ? null : node),
      doubleClickNode: ({ node }) => {
        onSelect(node);
        gotoNode(node);
      },
      clickStage: () => onSelect(null),
      enterNode: ({ node }) => onHover(node),
      leaveNode: () => onHover(null),
    });
  }, [registerEvents, onSelect, onHover, gotoNode, selected]);

  // New scan → fit the fresh graph in view.
  useEffect(() => {
    reset();
  }, [layoutKey, reset]);

  useEffect(() => {
    if (resetSignal > 0) reset();
  }, [resetSignal, reset]);

  useEffect(() => {
    if (focusNode) gotoNode(focusNode);
  }, [focusNode, focusNonce, gotoNode]);

  return null;
}

interface LayoutRunnerProps {
  layoutKey: string;
  onRunningChange: (running: boolean) => void;
  register: (api: { start: () => void; stop: () => void }) => void;
}

/** Runs ForceAtlas2 in a worker; auto-runs for a few seconds on each new graph. */
function LayoutRunner({ layoutKey, onRunningChange, register }: LayoutRunnerProps) {
  const { start, stop, isRunning } = useWorkerLayoutForceAtlas2({
    settings: {
      adjustSizes: true,
      gravity: 0.15,
      scalingRatio: 8,
      barnesHutOptimize: true,
      slowDown: 5,
    },
  });

  useEffect(() => {
    register({ start, stop });
  }, [register, start, stop]);

  useEffect(() => {
    onRunningChange(isRunning);
  }, [isRunning, onRunningChange]);

  useEffect(() => {
    start();
    const timer = window.setTimeout(stop, 8000);
    return () => window.clearTimeout(timer);
  }, [layoutKey, start, stop]);

  return null;
}

export default function SigmaFileGraph({
  graph: pg,
  selected,
  onSelect,
  query,
  colorMode,
  resetSignal,
  focusNode,
  focusNonce,
  layoutKey,
}: {
  graph: PgGraph;
  selected: string | null;
  onSelect: (id: string | null) => void;
  query: string;
  colorMode: ColorMode;
  resetSignal: number;
  focusNode: string | null;
  focusNonce: number;
  layoutKey: string;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [communityFilterId, setCommunityFilterId] = useState<number | null>(null);
  const [layoutRunning, setLayoutRunning] = useState(false);
  const layoutApi = useRef<{ start: () => void; stop: () => void } | null>(null);

  const { graph: g, communities } = useMemo(() => toGraphology(pg), [pg]);

  const view = useRef<ViewState>({
    selected,
    hovered,
    query,
    colorMode,
    communityFilterId,
    neighbors: EMPTY_NEIGHBORS,
  });

  const nodeReducer = useCallback<NodeReducer>((key, data, attrs) => {
    const v = view.current;
    const kind = (attrs.kind as PgKind | undefined) ?? "other";
    // File-kind mode still uses the vivid kind colors; community mode uses the palette.
    const baseColor =
      v.colorMode === "community" ? communityColor(Number(attrs.community ?? 0)) : (KIND_HEX[kind] ?? KIND_HEX.other);

    const q = v.query.trim().toLowerCase();
    if (q && !String(attrs.path ?? key).toLowerCase().includes(q)) return { visibility: "hidden" };
    if (v.communityFilterId !== null && Number(attrs.community) !== v.communityFilterId) {
      return { visibility: "hidden" };
    }

    // Hub-node glow, like the Reference: big nodes carry a colored halo.
    const glow =
      data.size >= 12
        ? {
            backdropVisibility: "visible" as const,
            backdropArea: "both" as const,
            backdropColor: withAlpha(baseColor, 0.22),
            backdropShadowColor: withAlpha(baseColor, 0.65),
            backdropShadowBlur: 16,
            backdropPadding: 10,
          }
        : {};

    if (v.selected) {
      if (key === v.selected) {
        return {
          color: BRAND,
          size: data.size * 1.35,
          zIndex: 10,
          labelColor: LABEL_COLOR,
          labelBackgroundColor: LABEL_BG,
          labelVisibility: "visible",
          backdropVisibility: "visible",
          backdropArea: "both",
          backdropColor: withAlpha(BRAND, 0.3),
          backdropShadowColor: withAlpha(BRAND, 0.8),
          backdropShadowBlur: 18,
          backdropPadding: 10,
        };
      }
      if (v.neighbors.has(key)) return { color: baseColor, labelColor: LABEL_COLOR, labelBackgroundColor: LABEL_BG, ...glow };
      return { color: "#6b7280", opacity: 0.3, size: data.size * 0.55, labelVisibility: "hidden" };
    }
    if (v.hovered === key) {
      return {
        color: baseColor,
        labelColor: LABEL_COLOR,
        labelBackgroundColor: LABEL_BG,
        size: data.size * 1.3,
        zIndex: 5,
        labelVisibility: "visible",
        backdropVisibility: "visible",
        backdropArea: "both",
        backdropColor: withAlpha(baseColor, 0.3),
        backdropShadowColor: withAlpha(baseColor, 0.8),
        backdropShadowBlur: 18,
        backdropPadding: 10,
      };
    }
    return { color: baseColor, labelColor: LABEL_COLOR, labelBackgroundColor: LABEL_BG, ...glow };
  }, []);

  const edgeReducer = useCallback<EdgeReducer>((key, _data, attrs, _state, _graphState, graph) => {
    const v = view.current;
    const source = graph.source(key);
    const target = graph.target(key);
    const baseColor = (attrs.color as string | undefined) ?? "rgba(156,163,175,0.45)";

    const q = v.query.trim().toLowerCase();
    if (q) {
      const a = String(graph.getNodeAttribute(source, "path") ?? "");
      const b = String(graph.getNodeAttribute(target, "path") ?? "");
      if (!a.toLowerCase().includes(q) && !b.toLowerCase().includes(q)) return { visibility: "hidden" };
    }
    if (v.communityFilterId !== null) {
      const ca = graph.getNodeAttribute(source, "community");
      const cb = graph.getNodeAttribute(target, "community");
      if (ca !== v.communityFilterId || cb !== v.communityFilterId) return { visibility: "hidden" };
    }

    // NOTE: size must stay above Sigma's minEdgeThickness (default 1.7) or
    // the edge is dropped entirely — we force it to 0 in settings below.
    if (v.selected) {
      if (source === v.selected || target === v.selected) return { color: withAlpha(BRAND, 0.95), size: 3, zIndex: 3 };
      return { color: "rgba(156,163,175,0.30)", size: 1.5, opacity: 0.4 };
    }
    if (v.hovered && (source === v.hovered || target === v.hovered)) {
      return { color: withAlpha(BRAND, 0.9), size: 2.5 };
    }
    return { color: baseColor, size: 2 };
  }, []);

  const options = useMemo(
    () => ({
      settings: {
        minEdgeThickness: 0,
        hideEdgesOnMove: true,
        hideLabelsOnMove: true,
        labelRenderedSizeThreshold: 5,
        enableNodeDrag: true,
        autoRescale: "once" as const,
      },
      nodeReducer,
      edgeReducer,
    }),
    [nodeReducer, edgeReducer],
  );

  const sigmaStyle = {
    "--sigma-background-color": CANVAS_BG,
    "--sigma-controls-background-color": "rgba(10,10,16,0.85)",
    "--sigma-controls-color": "#e5e7eb",
    "--sigma-controls-border-color": "rgba(255,255,255,0.15)",
    "--sigma-controls-background-color-hover": "rgba(255,255,255,0.1)",
  } as CSSProperties;

  const registerLayoutApi = useCallback((api: { start: () => void; stop: () => void }) => {
    layoutApi.current = api;
  }, []);

  return (
    <div
      className="relative min-h-0 min-w-0 flex-1"
      style={{ background: CANVAS_BG }}
      role="region"
      aria-label="Force-directed project graph. Drag to pan, scroll to zoom, click a node for details, double-click to focus it."
    >
      <SigmaContainer className="h-full w-full" options={options} style={sigmaStyle}>
        <GraphLoader
          graph={g}
          layoutKey={layoutKey}
          resetSignal={resetSignal}
          focusNode={focusNode}
          focusNonce={focusNonce}
          view={view}
          selected={selected}
          hovered={hovered}
          query={query}
          colorMode={colorMode}
          communityFilterId={communityFilterId}
          onSelect={onSelect}
          onHover={setHovered}
        />
        <LayoutRunner layoutKey={layoutKey} onRunningChange={setLayoutRunning} register={registerLayoutApi} />
        <ControlsContainer position="bottom-right">
          <ZoomControl />
        </ControlsContainer>
      </SigmaContainer>

      <div className="absolute left-3 top-3 max-h-[70%] w-52 overflow-y-auto rounded-lg border border-white/10 bg-black/50 p-2 shadow-lg backdrop-blur">
        {colorMode === "community" ? (
          <>
            <p className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-white/50">
              Communities · {communities.length}
            </p>
            <ul className="space-y-0.5">
              {communities.slice(0, 24).map((c) => {
                const active = communityFilterId === c.id;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-pressed={active}
                      title="Filter to this community (click again to clear)"
                      onClick={() => setCommunityFilterId(active ? null : c.id)}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] outline-none transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/40 ${
                        active ? "bg-white/15 text-white" : "text-white/70"
                      }`}
                    >
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c.color }} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">Community {c.id + 1}</span>
                      <span className="shrink-0 tabular-nums text-white/40">{c.count}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {communities.length > 24 && (
              <p className="px-2 pt-1 text-[11px] text-white/40">… {communities.length - 24} more</p>
            )}
            {communityFilterId !== null && (
              <p className="px-2 pt-1.5 text-[11px] text-white/40">Filtering — click again to clear.</p>
            )}
          </>
        ) : (
          <>
            <p className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-white/50">File kinds</p>
            <ul className="space-y-0.5">
              {(Object.keys(KIND_HEX) as PgKind[]).map((kind) => (
                <li key={kind} className="flex items-center gap-2 px-2 py-1 text-[12px] text-white/70">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: KIND_HEX[kind] }} aria-hidden="true" />
                  {KIND_LABEL[kind]}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <button
        type="button"
        aria-label={layoutRunning ? "Pause ForceAtlas2 layout" : "Run ForceAtlas2 layout"}
        onClick={() => {
          if (layoutRunning) layoutApi.current?.stop();
          else layoutApi.current?.start();
        }}
        className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/50 px-2.5 py-1.5 text-[12px] font-medium text-white/80 backdrop-blur outline-none transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/40"
      >
        {layoutRunning ? <Pause size={13} /> : <Play size={13} />}
        ForceAtlas2{layoutRunning ? " · running" : ""}
      </button>
    </div>
  );
}
