/**
 * GOAT G10: host pressure gate.
 *
 * Classifies the host's memory, disk and load into ok / warn / critical.
 * Each resource keeps its own level with hysteresis: a level is entered at
 * its threshold and only left once the value is back past the threshold by
 * a margin, so a host hovering on a line does not flap the gate.
 *
 * Disk trips a level only when BOTH limits hold: the used percent is at or
 * above its limit AND the free space is at or below its GiB limit (a 95 %
 * full 4 TB disk still has room; a small disk with 2 GiB free may be fine
 * at 60 %).
 *
 * The worker defers (never fails) a new task claim while the host is
 * critical, and reports the level on its heartbeat for the status line.
 * Written for Fhara; the ok/elevated/critical-with-hysteresis idea follows
 * GOAT's host pressure monitor, no code was copied.
 */
import { wenv } from "@fhara/config/worker";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type PressureLevel = "ok" | "warn" | "critical";
export type PressureResource = "memory" | "disk" | "load";

export const PRESSURE_RESOURCES: readonly PressureResource[] = ["memory", "disk", "load"];
const RANK: Record<PressureLevel, number> = { ok: 0, warn: 1, critical: 2 };

export interface HostPressureThresholds {
  /** Memory used, percent of total (0 = memory never trips). */
  memoryWarnPct: number;
  memoryCriticalPct: number;
  /** Disk used, percent; trips only together with the GiB limit. 0 = disk never trips. */
  diskWarnPct: number;
  diskCriticalPct: number;
  /** Disk free, GiB; trips only together with the percent limit. */
  diskWarnFreeGiB: number;
  diskCriticalFreeGiB: number;
  /** 1-minute load average per CPU, in percent (400 = 4 runnable per core). 0 = load never trips. */
  loadWarnPct: number;
  loadCriticalPct: number;
  /** Percent points (memory, disk percent) a value must fall back before a level is left. */
  hysteresisPct: number;
}

/** Warn levels derive from the critical ones, so only the critical limits are settings. */
export function thresholdsFromCritical(input: {
  memoryCriticalPct: number;
  diskCriticalPct: number;
  diskCriticalFreeGiB: number;
  loadCriticalPct: number;
}): HostPressureThresholds {
  return {
    memoryCriticalPct: input.memoryCriticalPct,
    memoryWarnPct: input.memoryCriticalPct > 0 ? Math.max(1, input.memoryCriticalPct - 10) : 0,
    diskCriticalPct: input.diskCriticalPct,
    diskWarnPct: input.diskCriticalPct > 0 ? Math.max(1, input.diskCriticalPct - 5) : 0,
    diskCriticalFreeGiB: input.diskCriticalFreeGiB,
    diskWarnFreeGiB: input.diskCriticalFreeGiB * 3,
    loadCriticalPct: input.loadCriticalPct,
    loadWarnPct: Math.round(input.loadCriticalPct * 0.75),
    hysteresisPct: 3,
  };
}

export const DEFAULT_PRESSURE_THRESHOLDS = thresholdsFromCritical({
  memoryCriticalPct: 95,
  diskCriticalPct: 95,
  diskCriticalFreeGiB: 2,
  loadCriticalPct: 400,
});

export interface HostSample {
  memoryUsedPct: number;
  diskUsedPct: number;
  diskFreeGiB: number;
  /** 1-minute load average per CPU, percent. */
  loadPct: number;
}

export interface PressureState {
  level: PressureLevel;
  resources: Record<PressureResource, PressureLevel>;
  /** Short human reasons for every resource above ok ("disk 96% used, 1.4 GiB free"). */
  reasons: string[];
  sample: HostSample | null;
}

export const OK_STATE: PressureState = {
  level: "ok",
  resources: { memory: "ok", disk: "ok", load: "ok" },
  reasons: [],
  sample: null,
};

type Check = { enters: (level: Exclude<PressureLevel, "ok">) => boolean; stays: (level: Exclude<PressureLevel, "ok">) => boolean };

function checks(sample: HostSample, t: HostPressureThresholds): Record<PressureResource, Check> {
  const m = t.hysteresisPct;
  const memLimit = (l: "warn" | "critical") => (l === "critical" ? t.memoryCriticalPct : t.memoryWarnPct);
  const diskPct = (l: "warn" | "critical") => (l === "critical" ? t.diskCriticalPct : t.diskWarnPct);
  const diskGiB = (l: "warn" | "critical") => (l === "critical" ? t.diskCriticalFreeGiB : t.diskWarnFreeGiB);
  const loadLimit = (l: "warn" | "critical") => (l === "critical" ? t.loadCriticalPct : t.loadWarnPct);
  // The GiB exit margin scales with the limit (at least half a GiB).
  const gibMargin = (l: "warn" | "critical") => Math.max(0.5, diskGiB(l) * 0.25);
  return {
    memory: {
      enters: (l) => memLimit(l) > 0 && sample.memoryUsedPct >= memLimit(l),
      stays: (l) => memLimit(l) > 0 && sample.memoryUsedPct >= memLimit(l) - m,
    },
    disk: {
      enters: (l) => diskPct(l) > 0 && sample.diskUsedPct >= diskPct(l) && sample.diskFreeGiB <= diskGiB(l),
      stays: (l) =>
        diskPct(l) > 0 && sample.diskUsedPct >= diskPct(l) - m && sample.diskFreeGiB <= diskGiB(l) + gibMargin(l),
    },
    load: {
      enters: (l) => loadLimit(l) > 0 && sample.loadPct >= loadLimit(l),
      stays: (l) => loadLimit(l) > 0 && sample.loadPct >= loadLimit(l) * 0.85,
    },
  };
}

function nextLevel(previous: PressureLevel, check: Check): PressureLevel {
  for (const level of ["critical", "warn"] as const) {
    if (check.enters(level)) return level;
    if (RANK[previous] >= RANK[level] && check.stays(level)) return level;
  }
  return "ok";
}

function reasonFor(resource: PressureResource, s: HostSample): string {
  if (resource === "memory") return `memory ${Math.round(s.memoryUsedPct)}% used`;
  if (resource === "disk") return `disk ${Math.round(s.diskUsedPct)}% used, ${s.diskFreeGiB.toFixed(1)} GiB free`;
  return `load ${(s.loadPct / 100).toFixed(1)} per CPU`;
}

/** Pure classifier: the new state from a sample and the previous state (hysteresis). */
export function classifyPressure(
  sample: HostSample,
  thresholds: HostPressureThresholds,
  previous: PressureState = OK_STATE
): PressureState {
  const c = checks(sample, thresholds);
  const resources = {} as Record<PressureResource, PressureLevel>;
  let level: PressureLevel = "ok";
  for (const r of PRESSURE_RESOURCES) {
    resources[r] = nextLevel(previous.resources[r], c[r]);
    if (RANK[resources[r]] > RANK[level]) level = resources[r];
  }
  const reasons = PRESSURE_RESOURCES.filter((r) => resources[r] !== "ok").map((r) => reasonFor(r, sample));
  return { level, resources, reasons, sample };
}

/**
 * Heartbeat capability for the status line: "pressure:critical:disk,memory".
 * None while ok. Fits the backend's 40-char capability cap.
 */
export function pressureCapability(state: PressureState): string | null {
  if (state.level === "ok") return null;
  const hot = PRESSURE_RESOURCES.filter((r) => state.resources[r] !== "ok");
  return `pressure:${state.level}:${hot.join(",")}`;
}

const GIB = 1024 ** 3;

function memoryUsedPct(): number {
  // MemAvailable (Linux) counts reclaimable cache as free; os.freemem does not.
  try {
    const info = readFileSync("/proc/meminfo", "utf8");
    const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(info)?.[1]);
    const total = kb("MemTotal");
    const available = kb("MemAvailable");
    if (total > 0 && Number.isFinite(available)) return ((total - available) / total) * 100;
  } catch {
    // not Linux: fall through
  }
  const total = os.totalmem();
  return total > 0 ? ((total - os.freemem()) / total) * 100 : 0;
}

/** Read the host once. Disk is measured on the filesystem holding `diskPath`. */
export function sampleHost(diskPath: string): HostSample {
  let diskUsedPct = 0;
  let diskFreeGiB = Number.POSITIVE_INFINITY;
  try {
    // The workspace root may not exist yet: measure its nearest existing ancestor.
    let target = path.resolve(diskPath);
    while (!existsSync(target) && path.dirname(target) !== target) target = path.dirname(target);
    const fs = statfsSync(target);
    const used = (fs.blocks - fs.bfree) * fs.bsize;
    const avail = fs.bavail * fs.bsize;
    // Like df: used / (used + available to unprivileged users).
    diskUsedPct = used + avail > 0 ? (used / (used + avail)) * 100 : 0;
    diskFreeGiB = avail / GIB;
  } catch {
    // unreadable path: disk counts as ok
  }
  const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  const loadPct = (os.loadavg()[0] / Math.max(1, cpus)) * 100; // 0 on Windows
  return { memoryUsedPct: memoryUsedPct(), diskUsedPct, diskFreeGiB, loadPct };
}

/** Holds the hysteresis state between samples; samples at most every `minIntervalMs`. */
export class HostPressureMonitor {
  private state: PressureState = OK_STATE;
  private sampledAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly opts: {
      thresholds: HostPressureThresholds;
      /** The filesystem to watch; a function follows a workspace root that Settings can change. */
      diskPath: string | (() => string);
      enabled?: boolean;
      minIntervalMs?: number;
      sample?: (diskPath: string) => HostSample;
      now?: () => number;
    }
  ) {}

  current(): PressureState {
    return this.state;
  }

  /** Re-sample when due and return the (possibly cached) state. A failed sample keeps the last state. */
  check(): PressureState {
    if (this.opts.enabled === false) return OK_STATE;
    const now = (this.opts.now ?? Date.now)();
    if (now - this.sampledAt < (this.opts.minIntervalMs ?? 5_000)) return this.state;
    this.sampledAt = now;
    try {
      const diskPath = typeof this.opts.diskPath === "function" ? this.opts.diskPath() : this.opts.diskPath;
      const sample = (this.opts.sample ?? sampleHost)(diskPath);
      this.state = classifyPressure(sample, this.opts.thresholds, this.state);
    } catch {
      // keep the last state
    }
    return this.state;
  }
}

/** The worker's monitor, from the WORKER_PRESSURE_* settings (read once at startup). */
export function createHostPressureMonitor(diskPath: string | (() => string)): HostPressureMonitor {
  return new HostPressureMonitor({
    enabled: wenv("WORKER_PRESSURE_GATE"),
    diskPath,
    thresholds: thresholdsFromCritical({
      memoryCriticalPct: wenv("WORKER_PRESSURE_MEMORY_PCT"),
      diskCriticalPct: wenv("WORKER_PRESSURE_DISK_PCT"),
      diskCriticalFreeGiB: wenv("WORKER_PRESSURE_DISK_GIB"),
      loadCriticalPct: wenv("WORKER_PRESSURE_LOAD_PCT"),
    }),
  });
}

export type GatedClaim<T> =
  | { kind: "claimed"; value: T }
  | { kind: "empty" }
  | { kind: "deferred"; state: PressureState; retryAfterMs: number };

/**
 * Claim new work unless the host is critical. At critical the claim is not
 * attempted at all: the task stays queued (nothing is marked failed) and the
 * caller retries after `retryAfterMs`.
 */
export async function claimUnlessPressured<T>(
  state: PressureState,
  claim: () => Promise<T | null | undefined>,
  retryAfterMs: number
): Promise<GatedClaim<T>> {
  if (state.level === "critical") return { kind: "deferred", state, retryAfterMs };
  const value = await claim();
  return value == null ? { kind: "empty" } : { kind: "claimed", value };
}
