import * as path from "node:path";
import { FileFinder, type FileItem } from "@ff-labs/fff-node";

/**
 * Lazy, per-workspace file index backed by `@ff-labs/fff-node` — the same
 * native finder FharaV2/T3Code uses (`apps/server/src/workspace`). It replaces
 * the hand-written directory walk and glob-to-RegExp parser in `repoRead`.
 *
 * The index never authorizes anything: `repoRead` still resolves the requested
 * path through the sandbox and post-filters every entry through the governed
 * path rules. fff already ignores gitignored files, `.env`, `.git`,
 * `node_modules`, and symlinks, so those never reach the filter either.
 */

export class WorkspaceIndexUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceIndexUnavailableError";
  }
}

const MAX_LIVE_INDEXES = 8;
const INDEX_READY_TIMEOUT_MS = 15_000;

interface LiveIndex {
  finder: FileFinder;
  lastUsed: number;
}

const indexes = new Map<string, LiveIndex>();

function workspaceKey(workspaceRoot: string): string {
  return path.resolve(workspaceRoot);
}

/** Whether the native library is present on this machine. */
export function workspaceIndexAvailable(): boolean {
  try {
    return FileFinder.isAvailable();
  } catch {
    return false;
  }
}

function evictLeastRecentlyUsed(): void {
  if (indexes.size < MAX_LIVE_INDEXES) return;
  let oldestKey: string | undefined;
  let oldest = Number.POSITIVE_INFINITY;
  for (const [key, live] of indexes) {
    if (live.lastUsed < oldest) {
      oldest = live.lastUsed;
      oldestKey = key;
    }
  }
  if (oldestKey === undefined) return;
  const live = indexes.get(oldestKey);
  indexes.delete(oldestKey);
  try {
    live?.finder.destroy();
  } catch {
    // A failed destroy must not break the caller; the process is fine.
  }
}

/**
 * The index for one workspace root, created on first use and kept warm.
 * The initial scan is awaited so the first tool call returns real entries.
 */
export async function getWorkspaceIndex(workspaceRoot: string): Promise<FileFinder> {
  const key = workspaceKey(workspaceRoot);
  const existing = indexes.get(key);
  if (existing && !existing.finder.isDestroyed) {
    existing.lastUsed = Date.now();
    return existing.finder;
  }
  indexes.delete(key);
  if (!workspaceIndexAvailable()) {
    throw new WorkspaceIndexUnavailableError(
      "The workspace search index (@ff-labs/fff-node) is not available on this machine."
    );
  }
  evictLeastRecentlyUsed();
  const created = FileFinder.create({
    basePath: key,
    // Agent mode: fewer background niceties, faster cold start.
    aiMode: true,
    followSymlinks: false,
  });
  if (!created.ok) {
    throw new WorkspaceIndexUnavailableError(`Could not index ${key}: ${created.error}`);
  }
  const finder = created.value;
  // A partial index is still usable: the caller caps and reports truncation.
  await finder.waitForScan(INDEX_READY_TIMEOUT_MS).catch(() => undefined);
  indexes.set(key, { finder, lastUsed: Date.now() });
  return finder;
}

/** Destroy one workspace's index (tests and project close). */
export function disposeWorkspaceIndex(workspaceRoot: string): void {
  const key = workspaceKey(workspaceRoot);
  const live = indexes.get(key);
  indexes.delete(key);
  try {
    live?.finder.destroy();
  } catch {
    // Ignore: dispose is best-effort.
  }
}

/** Destroy every live index (worker shutdown, test teardown). */
export function disposeAllWorkspaceIndexes(): void {
  for (const key of [...indexes.keys()]) disposeWorkspaceIndex(key);
}

export interface IndexedFile {
  relative: string;
  absolute: string;
  size: number;
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "");
}

/**
 * Files matching `pattern` (an npm-glob-compatible pattern) under the indexed
 * root, capped at `limit`. `totalMatched` is fff's own count before the cap so
 * the caller can report truncation.
 */
export async function listIndexedFiles(
  workspaceRoot: string,
  pattern: string,
  limit: number
): Promise<{ files: IndexedFile[]; totalMatched: number }> {
  const finder = await getWorkspaceIndex(workspaceRoot);
  const pageSize = Math.max(1, Math.min(limit + 1, 10_000));
  const result = finder.glob(pattern, { pageSize, pageIndex: 0 });
  if (!result.ok) {
    throw new WorkspaceIndexUnavailableError(`Index search failed: ${result.error}`);
  }
  const root = workspaceKey(workspaceRoot);
  const files: IndexedFile[] = [];
  for (const item of result.value.items as FileItem[]) {
    const relative = normalizeRelative(item.relativePath);
    if (!relative || relative === ".") continue;
    files.push({ relative, absolute: path.join(root, relative), size: item.size });
    if (files.length >= limit) break;
  }
  return { files, totalMatched: result.value.totalMatched };
}
