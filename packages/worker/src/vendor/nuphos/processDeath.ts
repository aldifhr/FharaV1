// Copied from Nuphos (https://github.com/nuphos/nuphos), apps/runtime/image/process-death.mjs @ a210a05.
// Copyright 2026 Zeabur Inc. Licensed under the Apache License, Version 2.0
// (http://www.apache.org/licenses/LICENSE-2.0). See THIRD_PARTY_NOTICES.md.
//
// Modified by Fhara, 2026-11: TypeScript; `nuphos*` identifiers and the
// cgroup-root constant renamed; the cgroup root and file reader are
// parameters (tests); the reason is built from an exit code/signal instead
// of the adapter's "terminated by signal" text; the death is described
// here in the worker that spawned the agent, not announced on stderr.

// Why the agent's process died, in words the person can act on. A SIGKILL
// while this cgroup's OOM kill count went up is the memory limit; any other
// death keeps its own reason. Either way the next message resumes the session.
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const CGROUP_ROOT = '/sys/fs/cgroup';

type Reader = (file: string) => string | null;

const readText: Reader = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** This process's cgroup v2 directory, or null outside one. */
export function ownCgroup(procCgroup: string | null = readText('/proc/self/cgroup'), root = CGROUP_ROOT): string | null {
  const path = procCgroup
    ?.split('\n')
    .find((line) => line.startsWith('0::'))
    ?.slice(3)
    .trim();
  return path ? `${root}${path === '/' ? '' : path}` : null;
}

/** How many times the kernel OOM-killed a process in this cgroup. */
export function oomKills(cgroup: string | null | undefined, read: Reader = readText): number {
  const events = cgroup ? read(`${cgroup}/memory.events`) : null;
  return Number(/^oom_kill (\d+)$/m.exec(events ?? '')?.[1] ?? 0);
}

/** The tightest memory limit above this cgroup, as "3.5 GB". */
export function memoryLimit(cgroup: string, root = CGROUP_ROOT, read: Reader = readText): string | null {
  let limit = Infinity;
  for (let dir = cgroup; dir.startsWith(root) && dir !== root && dir !== '/'; dir = dirname(dir)) {
    const max = Number(read(`${dir}/memory.max`)?.trim());
    if (max > 0 && max < limit) limit = max;
  }
  return Number.isFinite(limit) ? `${(limit / 1e9).toFixed(1)} GB` : null;
}

/** "process terminated by signal SIGKILL" / "process exited with code 1". */
export function exitReason(code: number | null, signal: NodeJS.Signals | string | null): string {
  if (signal) return `process terminated by signal ${signal}`;
  return `process exited with code ${code ?? 'unknown'}`;
}

export type ProcessDeath = {
  /** Who died, as the person knows it ("OpenCode", "The agent"). */
  agent: string;
  code: number | null;
  signal: NodeJS.Signals | string | null;
  /** The cgroup to check for an OOM kill (null: no check). */
  cgroup?: string | null;
  /** Its oom_kill count when the agent started. */
  oomKillsBefore?: number;
  cgroupRoot?: string;
  read?: Reader;
};

/** The cause of death in words, ending with what to do next. */
export function describeProcessDeath(death: ProcessDeath): string {
  const { agent, code, signal, cgroup, oomKillsBefore = 0, cgroupRoot = CGROUP_ROOT, read = readText } = death;
  if (signal === 'SIGKILL' && cgroup && oomKills(cgroup, read) > oomKillsBefore) {
    const limit = memoryLimit(cgroup, cgroupRoot, read);
    return `${agent} ran out of memory: this computer's agents reached their memory limit${limit ? ` (${limit})` : ''} and the system stopped it. Send a message to continue.`;
  }
  return `${agent} stopped unexpectedly (${exitReason(code, signal)}). Send a message to continue.`;
}
