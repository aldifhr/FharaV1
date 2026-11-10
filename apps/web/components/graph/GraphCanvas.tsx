"use client";

import { useId, type ReactNode } from "react";

/**
 * The small SVG graph canvas shared by the run page's Decomposer graph
 * (PlanGraph), the Team org chart and the collaboration graph. Nodes are
 * absolutely positioned HTML boxes (theme tokens); edges are plain SVG
 * paths in `currentColor`. Layout is the caller's job (lib/dagLayout.ts).
 *
 * Edge routes:
 *  - "horizontal": source's right edge → target's left edge (layered DAGs).
 *    An edge whose target is not to the right falls back to "direct".
 *  - "direct": box border to box border, slightly curved so A→B and B→A
 *    stay apart, with an arrowhead.
 * `weight` scales the stroke (1–4px against `maxWeight`); `label` prints
 * at the curve's midpoint.
 */

export interface CanvasNode {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
  onSelect?: () => void;
  muted?: boolean;
  label?: string;
  children: ReactNode;
}

export interface CanvasEdge {
  from: string;
  to: string;
  weight?: number;
  label?: string;
  title?: string;
  dashed?: boolean;
}

type Box = { x: number; y: number; w: number; h: number };

/** Where the ray from the box centre toward (tx, ty) leaves the box. */
function clip(box: Box, tx: number, ty: number): { x: number; y: number } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const t = Math.min(dx ? box.w / 2 / Math.abs(dx) : Infinity, dy ? box.h / 2 / Math.abs(dy) : Infinity);
  return { x: cx + dx * t, y: cy + dy * t };
}

export function edgePath(
  a: Box,
  b: Box,
  route: "horizontal" | "direct"
): { d: string; mid: { x: number; y: number }; arrow: boolean } {
  if (route === "horizontal" && b.x >= a.x + a.w) {
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const mid = (x1 + x2) / 2;
    return { d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`, mid: { x: mid, y: (y1 + y2) / 2 }, arrow: false };
  }
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  const len = Math.hypot(bx - ax, by - ay) || 1;
  // Perpendicular offset (always to the same side of the direction of
  // travel), so the two directions of one pair never overlap.
  const bend = Math.min(28, len * 0.15);
  const cx = (ax + bx) / 2 + (-(by - ay) / len) * bend;
  const cy = (ay + by) / 2 + ((bx - ax) / len) * bend;
  const start = clip(a, cx, cy);
  const end = clip(b, cx, cy);
  const mid = { x: 0.25 * start.x + 0.5 * cx + 0.25 * end.x, y: 0.25 * start.y + 0.5 * cy + 0.25 * end.y };
  return { d: `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`, mid, arrow: true };
}

export default function GraphCanvas({
  width,
  height,
  nodes,
  edges,
  route = "horizontal",
  maxWeight,
  ariaLabel,
}: {
  width: number;
  height: number;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  route?: "horizontal" | "direct";
  maxWeight?: number;
  ariaLabel?: string;
}) {
  const markerId = `arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const top = maxWeight ?? Math.max(1, ...edges.map((e) => e.weight ?? 1));
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-panel" aria-label={ariaLabel}>
      <div className="relative mx-auto" style={{ width, height }}>
        <svg width={width} height={height} className="absolute inset-0 text-line-strong" aria-hidden="true">
          <defs>
            <marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
            </marker>
          </defs>
          {edges.map((e) => {
            const a = byKey.get(e.from);
            const b = byKey.get(e.to);
            if (!a || !b || a === b) return null;
            const path = edgePath(a, b, route);
            const w = e.weight !== undefined ? 1 + 3 * Math.min(1, e.weight / top) : 1;
            return (
              <g key={`${e.from}->${e.to}`} className={e.weight !== undefined ? "text-ink-3" : undefined}>
                {e.title && <title>{e.title}</title>}
                <path
                  d={path.d}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={w}
                  strokeDasharray={e.dashed ? "4 3" : undefined}
                  markerEnd={path.arrow ? `url(#${markerId})` : undefined}
                  opacity={e.weight !== undefined ? 0.75 : 1}
                />
                {e.label && (
                  <text
                    x={path.mid.x}
                    y={path.mid.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    className="fill-ink-2 stroke-panel text-[10.5px] tabular-nums"
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {nodes.map((n) => (
          <button
            key={n.key}
            type="button"
            onClick={n.onSelect}
            title={n.title}
            aria-label={n.label}
            className={`absolute flex flex-col justify-center rounded-lg border border-line bg-canvas px-2.5 text-left outline-none transition hover:bg-hover focus-visible:border-line-strong ${n.muted ? "opacity-60" : ""}`}
            style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
          >
            {n.children}
          </button>
        ))}
      </div>
    </div>
  );
}
