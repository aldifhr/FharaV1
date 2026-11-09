"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import GraphCanvas from "@/components/graph/GraphCanvas";
import { layoutDag, positionLayers } from "@/lib/dagLayout";

const SIZE = { nodeW: 212, nodeH: 66, colGap: 56, rowGap: 10, pad: 12 };

/**
 * Org chart (orgIntel.orgChart): the CTO, then every fixed role in registry
 * order, then custom roles. A node shows the role, whether it is enabled,
 * the model, the library skills count and the tools; it opens the agent's
 * performance profile. Roles only, never @names.
 */
export default function OrgChart() {
  const router = useRouter();
  const chart = useQuery(api.orgIntel.orgChart, {});
  const graph = useMemo(() => {
    if (!chart) return null;
    const input = chart.nodes.map((n) => ({ key: n.key, dependencies: n.parent ? [n.parent] : [] }));
    const layout = layoutDag(input);
    return { layout, pos: positionLayers(layout, SIZE) };
  }, [chart]);

  return (
    <section className="mt-14" aria-labelledby="org-heading">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="org-heading" className="text-[17px] font-semibold tracking-tight">
          Org chart
        </h2>
        {chart && (
          <p className="text-[12.5px] text-ink-3">
            {chart.counts.enabled} of {chart.counts.agents} agents enabled
            {chart.counts.vacant ? ` · ${chart.counts.vacant} role${chart.counts.vacant === 1 ? "" : "s"} without an agent` : ""}
            {chart.counts.custom ? ` · ${chart.counts.custom} custom` : ""}
          </p>
        )}
      </header>
      {!chart || !graph ? (
        <div className="mt-6 h-64 animate-pulse rounded-xl bg-hover" aria-label="Loading org chart" />
      ) : (
        <div className="mt-6">
          <GraphCanvas
            ariaLabel="Org chart"
            width={graph.pos.width}
            height={graph.pos.height}
            edges={graph.layout.edges}
            nodes={chart.nodes.map((n) => {
              const state = !n.agentId ? "no agent" : n.enabled ? null : "disabled";
              const tools = n.tools.length ? n.tools.join(", ") : "no tools";
              return {
                key: n.key,
                ...graph.pos.boxOf(n.key),
                muted: !n.agentId || !n.enabled,
                label: `${n.label}${state ? `, ${state}` : ""}`,
                onSelect: n.agentId ? () => router.push(`/team/${n.agentId}`) : undefined,
                title: [
                  n.registryName && n.registryName !== n.label ? n.registryName : n.label,
                  n.fixed ? null : "Custom role (not one of the nine fixed roles)",
                  n.registryEnabled === false ? "Disabled in the role registry" : null,
                  `Capabilities: ${n.capabilities.join(", ") || "none"}`,
                  `Tools: ${tools}`,
                  n.maxConcurrency ? `Concurrency limit: ${n.maxConcurrency}` : null,
                  n.agentId ? "Open performance profile" : null,
                ]
                  .filter(Boolean)
                  .join("\n"),
                children: (
                  <>
                    <span className="truncate text-[12.5px] font-medium text-ink">
                      {n.label}
                      {state && <span className="font-normal text-ink-3"> · {state}</span>}
                    </span>
                    <span className="truncate text-[11.5px] text-ink-2">
                      {n.model ?? "—"}
                      {n.runtime === "opencode" ? " · OpenCode" : ""}
                    </span>
                    <span className="truncate text-[11.5px] text-ink-3">
                      {n.skills} skill{n.skills === 1 ? "" : "s"} · {tools}
                    </span>
                  </>
                ),
              };
            })}
          />
        </div>
      )}
    </section>
  );
}
