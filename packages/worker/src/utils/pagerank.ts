// Weighted, personalised PageRank (power iteration), written for the repo
// map (execution/repoMap.ts) as a dependency-free stand-in for the
// `networkx.pagerank(G, weight="weight", personalization=p, dangling=p)`
// call in Aider's aider/repomap.py (get_ranked_tags). Same semantics as
// networkx: dangling nodes redistribute by the personalisation vector,
// convergence when the L1 change drops below N * tol.

export type WeightedGraph = Map<string, Map<string, number>>;

export function pagerank(
  nodes: Iterable<string>,
  edges: WeightedGraph,
  personalization?: ReadonlyMap<string, number>,
  options: { alpha?: number; maxIter?: number; tol?: number } = {}
): Map<string, number> {
  const alpha = options.alpha ?? 0.85;
  const maxIter = options.maxIter ?? 100;
  const tol = options.tol ?? 1e-6;
  const ids = [...new Set(nodes)];
  const n = ids.length;
  const result = new Map<string, number>();
  if (n === 0) return result;
  const index = new Map(ids.map((id, i) => [id, i] as const));

  // Personalisation vector p (normalised), uniform when absent or all-zero.
  const p = new Float64Array(n);
  let pTotal = 0;
  if (personalization) {
    for (const [id, value] of personalization) {
      const i = index.get(id);
      if (i === undefined || !(value > 0)) continue;
      p[i] += value;
      pTotal += value;
    }
  }
  if (pTotal > 0) for (let i = 0; i < n; i += 1) p[i] /= pTotal;
  else p.fill(1 / n);

  // Row-normalised out edges.
  const outTargets: number[][] = Array.from({ length: n }, () => []);
  const outWeights: number[][] = Array.from({ length: n }, () => []);
  const dangling: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const row = edges.get(ids[i]);
    let total = 0;
    if (row) for (const weight of row.values()) if (weight > 0) total += weight;
    if (!row || total <= 0) {
      dangling.push(i);
      continue;
    }
    for (const [target, weight] of row) {
      const j = index.get(target);
      if (j === undefined || !(weight > 0)) continue;
      outTargets[i].push(j);
      outWeights[i].push(weight / total);
    }
  }

  let x = new Float64Array(n).fill(1 / n);
  for (let iter = 0; iter < maxIter; iter += 1) {
    const last = x;
    x = new Float64Array(n);
    let danglingSum = 0;
    for (const i of dangling) danglingSum += last[i];
    for (let i = 0; i < n; i += 1) {
      const share = alpha * last[i];
      const targets = outTargets[i];
      const weights = outWeights[i];
      for (let k = 0; k < targets.length; k += 1) x[targets[k]] += share * weights[k];
    }
    const base = alpha * danglingSum + (1 - alpha);
    let err = 0;
    for (let i = 0; i < n; i += 1) {
      x[i] += base * p[i];
      err += Math.abs(x[i] - last[i]);
    }
    if (err < n * tol) break;
  }
  for (let i = 0; i < n; i += 1) result.set(ids[i], x[i]);
  return result;
}
