/**
 * Layered (topological-level) layout for the Task Decomposer graph. Pure:
 * level = 0 for a node without known dependencies, else 1 + the deepest
 * dependency's level; nodes keep their input order inside a level. Cycles
 * (never in a validated plan) are broken by treating the back edge as absent.
 */
export interface DagInput {
  key: string;
  dependencies: string[];
}

export interface DagLayout {
  levels: string[][];
  levelOf: Map<string, number>;
  rowOf: Map<string, number>;
  edges: Array<{ from: string; to: string }>;
}

export function layoutDag(nodes: DagInput[]): DagLayout {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const levelOf = new Map<string, number>();
  const visiting = new Set<string>();
  const level = (key: string): number => {
    const known = levelOf.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return 0;
    visiting.add(key);
    let value = 0;
    for (const dep of byKey.get(key)?.dependencies ?? []) {
      if (byKey.has(dep) && dep !== key) value = Math.max(value, level(dep) + 1);
    }
    visiting.delete(key);
    levelOf.set(key, value);
    return value;
  };
  for (const n of nodes) level(n.key);
  const levels: string[][] = [];
  const rowOf = new Map<string, number>();
  for (const n of nodes) {
    const l = levelOf.get(n.key) ?? 0;
    (levels[l] ??= []).push(n.key);
    rowOf.set(n.key, levels[l].length - 1);
  }
  const edges: DagLayout["edges"] = [];
  for (const n of nodes) {
    for (const dep of n.dependencies) if (byKey.has(dep) && dep !== n.key) edges.push({ from: dep, to: n.key });
  }
  return { levels: levels.map((l) => l ?? []), levelOf, rowOf, edges };
}

/**
 * Pixel boxes for a layered layout: one column per level (left → right),
 * shorter columns centred vertically. Shared by the Decomposer graph and
 * the Team org chart.
 */
export function positionLayers(
  layout: Pick<DagLayout, "levels" | "levelOf" | "rowOf">,
  size: { nodeW: number; nodeH: number; colGap: number; rowGap: number; pad: number }
): { width: number; height: number; boxOf: (key: string) => { x: number; y: number; w: number; h: number } } {
  const { nodeW, nodeH, colGap, rowGap, pad } = size;
  const columns = Math.max(1, layout.levels.length);
  const rows = Math.max(1, ...layout.levels.map((l) => l.length));
  return {
    width: pad * 2 + columns * nodeW + (columns - 1) * colGap,
    height: pad * 2 + rows * nodeH + (rows - 1) * rowGap,
    boxOf: (key: string) => {
      const level = layout.levelOf.get(key) ?? 0;
      const row = layout.rowOf.get(key) ?? 0;
      const count = layout.levels[level]?.length ?? 1;
      const offset = ((rows - count) * (nodeH + rowGap)) / 2;
      return { x: pad + level * (nodeW + colGap), y: pad + offset + row * (nodeH + rowGap), w: nodeW, h: nodeH };
    },
  };
}

/** Boxes on a ring (collaboration graph): first key at the top, clockwise. */
export function positionRing(
  keys: string[],
  size: { nodeW: number; nodeH: number; pad: number; minRadius?: number }
): { width: number; height: number; boxOf: (key: string) => { x: number; y: number; w: number; h: number } } {
  const { nodeW, nodeH, pad } = size;
  const n = Math.max(1, keys.length);
  // Radius so neighbouring boxes do not overlap on the circumference.
  const radius = Math.max(size.minRadius ?? 120, (n * (nodeW * 0.62 + 12)) / (2 * Math.PI));
  const width = pad * 2 + radius * 2 + nodeW;
  const height = pad * 2 + radius * 2 + nodeH;
  const index = new Map(keys.map((k, i) => [k, i]));
  return {
    width: Math.ceil(width),
    height: Math.ceil(height),
    boxOf: (key: string) => {
      const i = index.get(key) ?? 0;
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
      const cx = width / 2 + radius * Math.cos(angle);
      const cy = height / 2 + radius * Math.sin(angle);
      return { x: cx - nodeW / 2, y: cy - nodeH / 2, w: nodeW, h: nodeH };
    },
  };
}
