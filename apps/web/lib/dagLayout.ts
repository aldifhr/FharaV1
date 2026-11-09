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
