"use client";

import { useMemo } from "react";
import { roleLabel } from "@/lib/agentRoles";
import { statusDot } from "@/lib/runFormat";
import { layoutDag } from "@/lib/dagLayout";

/**
 * Task Decomposer graph: the plan's subtasks as a small DAG. Nodes show the
 * role and title; edges are dependencies; the only colour is the status dot
 * (same colours as the timeline). Simple layered layout, plain SVG edges.
 */

type GraphNode = {
  key: string;
  title: string;
  kind: string;
  status: string;
  role: string | null;
  dependencies: string[];
  origin: string | null;
};

const NODE_W = 172;
const NODE_H = 46;
const COL_GAP = 44;
const ROW_GAP = 14;
const PAD = 12;

export default function PlanGraph({ nodes, onSelect }: { nodes: GraphNode[]; onSelect?: (key: string) => void }) {
  const layout = useMemo(() => layoutDag(nodes), [nodes]);
  if (nodes.length === 0) {
    return <p className="rounded-xl border border-line bg-panel px-4 py-3 text-[13px] text-ink-3">No subtasks to draw.</p>;
  }
  const rows = Math.max(...layout.levels.map((l) => l.length));
  const width = PAD * 2 + layout.levels.length * NODE_W + (layout.levels.length - 1) * COL_GAP;
  const height = PAD * 2 + rows * NODE_H + (rows - 1) * ROW_GAP;
  const pos = (key: string) => {
    const level = layout.levelOf.get(key) ?? 0;
    const row = layout.rowOf.get(key) ?? 0;
    // Center shorter columns vertically.
    const count = layout.levels[level]?.length ?? 1;
    const offset = ((rows - count) * (NODE_H + ROW_GAP)) / 2;
    return { x: PAD + level * (NODE_W + COL_GAP), y: PAD + offset + row * (NODE_H + ROW_GAP) };
  };
  const byKey = new Map(nodes.map((n) => [n.key, n]));

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-panel">
      <div className="relative" style={{ width, height }}>
        <svg width={width} height={height} className="absolute inset-0 text-line-strong" aria-hidden="true">
          {layout.edges.map((e) => {
            const a = pos(e.from);
            const b = pos(e.to);
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            const mid = (x1 + x2) / 2;
            return (
              <path
                key={`${e.from}->${e.to}`}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1}
              />
            );
          })}
        </svg>
        {nodes.map((n) => {
          const p = pos(n.key);
          const deps = n.dependencies.filter((d) => byKey.has(d));
          return (
            <button
              key={n.key}
              type="button"
              onClick={() => onSelect?.(n.key)}
              title={`${n.title}\n${n.kind.replace(/_/g, " ")} · ${n.status.replace(/_/g, " ")}${deps.length ? `\nafter ${deps.map((d) => byKey.get(d)?.title ?? d).join(", ")}` : ""}`}
              className="absolute flex flex-col justify-center rounded-lg border border-line bg-canvas px-2.5 text-left outline-none transition hover:bg-hover focus-visible:border-line-strong"
              style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-ink">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(n.status)}`} />
                <span className="truncate">{n.role ? roleLabel(n.role) : "Unassigned"}</span>
              </span>
              <span className="truncate text-[11.5px] text-ink-3">{n.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
