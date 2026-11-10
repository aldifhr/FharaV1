/**
 * The model order: one ordered list of models across provider connections.
 *
 * Settings → LLM & Models shows one list; its order IS the fallback order,
 * and in round robin the list is the rotation set (order = start priority).
 * The order is stored as `llmModels.position`. Rows written before the list
 * existed have no position and keep the old order after the positioned
 * ones: connection priority (lower first), then weight (heavier first).
 *
 * Pure module (no Convex import): backend chat (lib/chat/llm.ts) and the
 * worker resolver (packages/worker/src/llm/resolver.ts) both order the
 * pool through `orderPoolPairs`, so a chat reply and a task call walk the
 * same list.
 */
import { rotateFrom, type StickyCursor } from "./llmRotation";
import type { LlmSelectionMode } from "./llmSelection";

export interface OrderableModel {
  _id?: string;
  modelId: string;
  isAvailable: boolean;
  position?: number;
}

export interface OrderableConnection<M extends OrderableModel = OrderableModel> {
  _id: string;
  priority: number;
  weight: number;
  modelPatterns?: string[];
  models: M[];
}

export interface PoolPair<C extends OrderableConnection> {
  connection: C;
  model: C["models"][number];
}

/** Glob match for model patterns: only `*` is special (e.g. `gpt-4*`). */
export function matchesModelPattern(pattern: string, modelId: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(modelId);
}

export function connectionServesModel(
  connection: { modelPatterns?: string[] },
  model: { modelId: string }
): boolean {
  const patterns = connection.modelPatterns;
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((pattern) => matchesModelPattern(pattern, model.modelId));
}

function comparePairs<C extends OrderableConnection>(
  a: PoolPair<C> & { index: number },
  b: PoolPair<C> & { index: number }
): number {
  const pa = a.model.position;
  const pb = b.model.position;
  const hasA = typeof pa === "number";
  const hasB = typeof pb === "number";
  if (hasA && hasB && pa !== pb) return pa! - pb!;
  if (hasA !== hasB) return hasA ? -1 : 1;
  return (
    a.connection.priority - b.connection.priority ||
    b.connection.weight - a.connection.weight ||
    a.index - b.index
  );
}

/**
 * Every usable (connection, model) pair in list order: available models
 * the connection's patterns allow, positioned models first by position,
 * then the rest by connection priority and weight. Stable.
 */
export function orderPoolPairs<C extends OrderableConnection>(
  pool: readonly C[],
  accept: (pair: PoolPair<C>) => boolean = () => true
): PoolPair<C>[] {
  const pairs: (PoolPair<C> & { index: number })[] = [];
  let index = 0;
  for (const connection of pool) {
    for (const model of connection.models) {
      const pair = { connection, model };
      index++;
      if (!model.isAvailable) continue;
      if (!connectionServesModel(connection, model)) continue;
      if (!accept(pair)) continue;
      pairs.push({ ...pair, index });
    }
  }
  return pairs.sort(comparePairs).map(({ connection, model }) => ({ connection, model }));
}

/** True when the user has set an explicit list order (any model positioned). */
export function hasExplicitOrder(pairs: readonly { model: OrderableModel }[]): boolean {
  return pairs.some((pair) => typeof pair.model.position === "number");
}

/**
 * Apply the selection mode to an ordered list: fallback keeps the list,
 * round robin rotates its start (sticky cursor). The whole rotated list
 * stays the failover chain either way.
 */
export function applySelectionMode<T>(
  ordered: readonly T[],
  mode: LlmSelectionMode | "round_robin" | undefined,
  cursor: StickyCursor
): T[] {
  if (mode !== "round_robin" || ordered.length <= 1) return [...ordered];
  return rotateFrom(ordered, cursor.next(ordered.length));
}

/**
 * Positions for a full reorder: index i → position i. Connection priority
 * follows the first position of its models, so callers that still read
 * connection priority (legacy paths) see the same order.
 */
export function positionsFromOrder(
  orderedModelIds: readonly string[],
  modelProvider: ReadonlyMap<string, string>
): { positions: Map<string, number>; providerPriority: Map<string, number> } {
  const positions = new Map<string, number>();
  const providerPriority = new Map<string, number>();
  orderedModelIds.forEach((id, index) => {
    positions.set(id, index);
    const providerId = modelProvider.get(id);
    if (providerId && !providerPriority.has(providerId)) providerPriority.set(providerId, index);
  });
  return { positions, providerPriority };
}

/** Next free position (append at the end of the list). */
export function nextPosition(models: readonly { position?: number }[]): number {
  let max = -1;
  for (const model of models) {
    if (typeof model.position === "number" && model.position > max) max = model.position;
  }
  return max + 1;
}

/**
 * Every model row in list order, unavailable ones included (the Settings
 * list and reorder use it). Same comparator as orderPoolPairs.
 */
export function sortModelRows<M extends { _id: string; providerId: string; position?: number; modelId: string }>(
  models: readonly M[],
  providers: readonly { _id: string; priority: number; weight: number }[]
): M[] {
  const providerIndex = new Map(providers.map((p, i) => [String(p._id), { p, i }]));
  const missing = { p: { priority: Number.MAX_SAFE_INTEGER, weight: 0 }, i: Number.MAX_SAFE_INTEGER };
  return models
    .map((model, index) => ({ model, index, meta: providerIndex.get(String(model.providerId)) ?? missing }))
    .sort((a, b) => {
      const pa = a.model.position;
      const pb = b.model.position;
      const hasA = typeof pa === "number";
      const hasB = typeof pb === "number";
      if (hasA && hasB && pa !== pb) return pa! - pb!;
      if (hasA !== hasB) return hasA ? -1 : 1;
      return (
        a.meta.p.priority - b.meta.p.priority ||
        b.meta.p.weight - a.meta.p.weight ||
        a.meta.i - b.meta.i ||
        a.index - b.index
      );
    })
    .map(({ model }) => model);
}
