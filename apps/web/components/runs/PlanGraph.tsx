"use client";

import { useMemo } from "react";
import { roleLabel } from "@/lib/agentRoles";
import { statusDot } from "@/lib/runFormat";
import { layoutDag, positionLayers } from "@/lib/dagLayout";
import GraphCanvas from "@/components/graph/GraphCanvas";

/**
 * Task Decomposer graph: the plan's subtasks as a small DAG. Nodes show the
 * role and title; edges are dependencies; the only colour is the status dot
 * (same colours as the timeline). Simple layered layout, plain SVG edges
 * (GraphCanvas, shared with the Team org chart and collaboration graph).
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

const SIZE = { nodeW: 172, nodeH: 46, colGap: 44, rowGap: 14, pad: 12 };

export default function PlanGraph({ nodes, onSelect }: { nodes: GraphNode[]; onSelect?: (key: string) => void }) {
  const layout = useMemo(() => layoutDag(nodes), [nodes]);
  if (nodes.length === 0) {
    return <p className="rounded-xl border border-line bg-panel px-4 py-3 text-[13px] text-ink-3">No subtasks to draw.</p>;
  }
  const { width, height, boxOf } = positionLayers(layout, SIZE);
  const byKey = new Map(nodes.map((n) => [n.key, n]));

  return (
    <GraphCanvas
      width={width}
      height={height}
      edges={layout.edges}
      nodes={nodes.map((n) => {
        const deps = n.dependencies.filter((d) => byKey.has(d));
        return {
          key: n.key,
          ...boxOf(n.key),
          onSelect: () => onSelect?.(n.key),
          title: `${n.title}\n${n.kind.replace(/_/g, " ")} · ${n.status.replace(/_/g, " ")}${deps.length ? `\nafter ${deps.map((d) => byKey.get(d)?.title ?? d).join(", ")}` : ""}`,
          children: (
            <>
              <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-ink">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(n.status)}`} />
                <span className="truncate">{n.role ? roleLabel(n.role) : "Unassigned"}</span>
              </span>
              <span className="truncate text-[11.5px] text-ink-3">{n.title}</span>
            </>
          ),
        };
      })}
    />
  );
}
