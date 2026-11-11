// Adapted from Nuphos (https://github.com/nuphos/nuphos) @ a210a05:
// scripts/dev-shutdown.ts (`stopTree`, `waitGroupGone`: SIGTERM the group,
// wait for every member, SIGKILL what is left) and scripts/dev-instance.ts
// (`reapLeftovers`: groups a dead launcher spawned, reaped only once they are
// verified to still be its own).
// Copyright 2026 Zeabur Inc. Licensed under the Apache License, Version 2.0
// (http://www.apache.org/licenses/LICENSE-2.0). See THIRD_PARTY_NOTICES.md.
//
// Modified by Fhara, 2026-11: a registry of ACP agent process groups the
// worker spawned (one 0600 file per worker process, written atomically), a
// boot sweep for groups whose worker died, and a verification step before any
// signal (the leader's start time and command line must match the record, and
// a leaderless group's members must have started after it). Group membership
// is read from /proc, so zombies count as gone.

// Why: an ACP agent runs in its own process group (connection.ts spawns it
// detached) and OpenCode ignores stdin EOF, so when the worker crashes or is
// SIGKILLed (scripts/supervise.mjs only signals the worker's own group) the
// agent and its MCP children live on. The next worker reaps them here.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildChildEnv } from "@/api/convex/lib/childEnv";

export const AGENT_PIDS_VERSION = 1;

/** One agent process group this worker spawned (the leader's pid is its pgid). */
export type AgentPidRecord = {
  pid: number;
  /** The leader's start time as the OS reports it (/proc ticks since boot, or `ps lstart`). */
  startTime: string;
  /** The leader's command line at spawn, NUL-joined. */
  cmdline: string;
  /** The spawn's own arguments; any exec wrapper keeps them. */
  args: string[];
  label?: string;
  spawnedAt: number;
};

export type AgentPidsFile = {
  version: number;
  owner: { pid: number; startTime: string | null };
  agents: AgentPidRecord[];
};

/** What the registry needs to know about a running process; null when it is gone or unreadable. */
export interface ProcReader {
  startTime(pid: number): string | null;
  cmdline(pid: number): string | null;
  /** The process group of `pid`. */
  pgid(pid: number): number | null;
  /** Live (non-zombie) members of a group with their start times; null when the OS can't list them. */
  groupMembers(pgid: number): { pid: number; startTime: string }[] | null;
}

function readProc(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Fields of /proc/<pid>/stat after the command name: [state, ppid, pgrp, ...]; starttime is index 19. */
function procStat(pid: number): string[] | null {
  const stat = readProc(`/proc/${pid}/stat`);
  if (!stat) return null;
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  return stat.slice(close + 2).trim().split(/\s+/);
}

export const linuxProc: ProcReader = {
  startTime(pid) {
    const f = procStat(pid);
    if (!f || f[0] === "Z" || f[0] === "X") return null;
    return f[19] ?? null;
  },
  cmdline(pid) {
    const raw = readProc(`/proc/${pid}/cmdline`);
    return raw ? raw.replace(/\0+$/, "") : null;
  },
  pgid(pid) {
    const f = procStat(pid);
    return f ? Number(f[2]) : null;
  },
  groupMembers(pgid) {
    let entries: string[];
    try {
      entries = fs.readdirSync("/proc");
    } catch {
      return null;
    }
    const out: { pid: number; startTime: string }[] = [];
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const f = procStat(Number(name));
      if (!f || f[0] === "Z" || f[0] === "X" || Number(f[2]) !== pgid) continue;
      out.push({ pid: Number(name), startTime: f[19] ?? "" });
    }
    return out;
  },
};

function ps(pid: number, field: string): string | null {
  try {
    const out = execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", env: buildChildEnv(), stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** macOS and other POSIX systems: `ps`. A leaderless group is never listed there, so it is left alone. */
export const psProc: ProcReader = {
  startTime: (pid) => ps(pid, "lstart"),
  // `ps` gives the command line space-joined; the record stores it the same way.
  cmdline: (pid) => ps(pid, "command"),
  pgid(pid) {
    const v = ps(pid, "pgid");
    return v ? Number(v) : null;
  },
  groupMembers: () => null,
};

export function defaultProcReader(): ProcReader | null {
  if (process.platform === "win32") return null; // no process groups; the agent is not detached there
  if (process.platform === "linux" && fs.existsSync("/proc/self/stat")) return linuxProc;
  return psProc;
}

/** `~/.fhara/run/acp-pgids`: one file per worker process. */
export function defaultAgentPidsDir(): string {
  return path.join(os.homedir(), ".fhara", "run", "acp-pgids");
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // gone (or not ours: EPERM)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ReapResult = { pid: number; outcome: "reaped" | "gone" | "skipped"; reason: string };

export type AgentPidRegistryOptions = {
  dir?: string;
  proc?: ProcReader | null;
  /** Whose file this is; default this process. Tests pass a child "worker". */
  ownerPid?: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
  /** SIGTERM → wait → SIGKILL. */
  graceMs?: number;
};

/** Is the recorded group still the one this worker spawned? Never true on a doubt. */
export function verifyRecord(rec: AgentPidRecord, proc: ProcReader): { ok: true; members: number[] } | { ok: false; reason: string } {
  if (!Number.isInteger(rec.pid) || rec.pid <= 1 || rec.pid === process.pid) return { ok: false, reason: "invalid pid" };
  const leaderStart = proc.startTime(rec.pid);
  if (leaderStart !== null) {
    if (leaderStart !== rec.startTime) return { ok: false, reason: "pid reused (start time differs)" };
    const cmd = proc.cmdline(rec.pid);
    if (cmd === null) return { ok: false, reason: "command line unreadable" };
    const argv = cmd.split(/[\0 ]/);
    const sameCmd = cmd === rec.cmdline || (rec.args.length > 0 && rec.args.every((a) => argv.includes(a)));
    if (!sameCmd) return { ok: false, reason: "command line differs" };
    if (proc.pgid(rec.pid) !== rec.pid) return { ok: false, reason: "no longer a group leader" };
    const members = proc.groupMembers(rec.pid);
    return { ok: true, members: members ? members.map((m) => m.pid) : [rec.pid] };
  }
  // The leader is gone; its children (MCP servers) can keep the group. A
  // pgid isn't reused while any member lives, and every member of the
  // agent's group started after its leader did.
  const members = proc.groupMembers(rec.pid);
  if (members === null) return { ok: false, reason: "leader gone; the group can't be listed here" };
  if (members.length === 0) return { ok: false, reason: "gone" };
  const recStart = Number(rec.startTime);
  if (!Number.isFinite(recStart)) return { ok: false, reason: "leader gone; start time not comparable" };
  if (members.some((m) => !(Number(m.startTime) >= recStart))) return { ok: false, reason: "group has a member older than the agent" };
  return { ok: true, members: members.map((m) => m.pid) };
}

/**
 * The worker's record of the agent process groups it spawned. `spawned` and
 * `exited` keep this process's file current; `sweep` (worker boot) reaps the
 * groups of workers that died; `reapOwn` (graceful shutdown) and the exit
 * hook stop whatever this worker still has.
 */
export class AgentPidRegistry {
  readonly dir: string;
  readonly file: string;
  private readonly proc: ProcReader | null;
  private readonly ownerPid: number;
  private readonly ownerStart: string | null;
  private readonly log: (message: string, data?: Record<string, unknown>) => void;
  private readonly graceMs: number;
  private agents = new Map<number, AgentPidRecord>();
  private exitHook?: () => void;

  constructor(opts: AgentPidRegistryOptions = {}) {
    this.dir = opts.dir ?? defaultAgentPidsDir();
    this.proc = opts.proc === undefined ? defaultProcReader() : opts.proc;
    this.ownerPid = opts.ownerPid ?? process.pid;
    this.ownerStart = this.proc?.startTime(this.ownerPid) ?? null;
    this.file = path.join(this.dir, `${this.ownerPid}.json`);
    this.log = opts.log ?? (() => undefined);
    this.graceMs = opts.graceMs ?? 2000;
  }

  get enabled(): boolean {
    return this.proc !== null;
  }

  records(): AgentPidRecord[] {
    return [...this.agents.values()];
  }

  /** Records a freshly spawned agent (its own group leader). */
  spawned(pid: number, cmd: { args: string[]; label?: string }): void {
    if (!this.proc || !pid) return;
    const startTime = this.proc.startTime(pid);
    if (startTime === null) return; // already gone
    this.agents.set(pid, { pid, startTime, cmdline: this.proc.cmdline(pid) ?? "", args: [...cmd.args], label: cmd.label, spawnedAt: Date.now() });
    this.write();
  }

  /**
   * The leader exited. The record stays while its group still has members
   * (they're stopped at shutdown or by the next boot sweep).
   */
  exited(pid: number): void {
    const rec = this.agents.get(pid);
    if (!rec || !this.proc) return;
    const members = this.proc.groupMembers(pid);
    if (members !== null && members.length > 0) return;
    this.agents.delete(pid);
    this.write();
  }

  private write(): void {
    try {
      if (this.agents.size === 0) return void fs.rmSync(this.file, { force: true });
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const body: AgentPidsFile = { version: AGENT_PIDS_VERSION, owner: { pid: this.ownerPid, startTime: this.ownerStart }, agents: this.records() };
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (error) {
      this.log("could not write the agent pid registry", { file: this.file, error: String(error) });
    }
  }

  /** Is the worker that wrote this file still running? A file with no owner start time counts as yes. */
  private ownerAlive(owner: AgentPidsFile["owner"]): boolean {
    if (!this.proc) return true;
    if (owner.pid === this.ownerPid) return owner.startTime === this.ownerStart;
    const now = this.proc.startTime(owner.pid);
    // Gone or a zombie (no start time): dead. Its agents are still verified
    // one by one before any signal.
    if (now === null) return false;
    return owner.startTime === null || now === owner.startTime;
  }

  /** SIGTERM the verified group, wait for every member, SIGKILL any left. */
  private async stopGroup(rec: AgentPidRecord): Promise<ReapResult> {
    const proc = this.proc!;
    const v = verifyRecord(rec, proc);
    if (!v.ok) return { pid: rec.pid, outcome: v.reason === "gone" ? "gone" : "skipped", reason: v.reason };
    signalGroup(rec.pid, "SIGTERM");
    if (await this.waitGone(rec.pid, this.graceMs)) return { pid: rec.pid, outcome: "reaped", reason: "SIGTERM" };
    // Re-verify: a pid can't be reused while the group lives, but stay strict.
    const again = verifyRecord(rec, proc);
    if (!again.ok) return { pid: rec.pid, outcome: again.reason === "gone" ? "reaped" : "skipped", reason: again.reason };
    signalGroup(rec.pid, "SIGKILL");
    await this.waitGone(rec.pid, 2000);
    return { pid: rec.pid, outcome: "reaped", reason: "SIGKILL" };
  }

  private async waitGone(pgid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      const members = this.proc!.groupMembers(pgid);
      const alive = members === null ? this.proc!.startTime(pgid) !== null : members.length > 0;
      if (!alive) return true;
      if (Date.now() >= deadline) return false;
      await sleep(50);
    }
  }

  /**
   * Worker boot, before the first claim: reaps every recorded group whose
   * worker is gone, after verifying it, and removes those files. A file of
   * a live worker (another checkout running side by side) is left alone.
   */
  async sweep(): Promise<ReapResult[]> {
    if (!this.proc) return [];
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const results: ReapResult[] = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      if (name.endsWith(".tmp")) {
        // A write that never finished: `<owner>.json.<writer pid>.<ms>.tmp`.
        const owner = Number(name.split(".")[2]);
        if (!Number.isInteger(owner) || this.proc.startTime(owner) === null) fs.rmSync(file, { force: true });
        continue;
      }
      // This process's own path is handled like any other: ownerAlive tells a
      // previous process that had the same pid from this one.
      if (!/^\d+\.json$/.test(name)) continue;
      let body: AgentPidsFile;
      try {
        body = JSON.parse(fs.readFileSync(file, "utf8")) as AgentPidsFile;
      } catch {
        this.log("unreadable agent pid file removed", { file });
        fs.rmSync(file, { force: true });
        continue;
      }
      if (!body?.owner || !Array.isArray(body.agents)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (this.ownerAlive(body.owner)) continue;
      for (const rec of body.agents) {
        const r = await this.stopGroup(rec);
        results.push(r);
        if (r.outcome === "reaped") this.log("reaped a leftover agent process group", { pgid: rec.pid, label: rec.label, how: r.reason });
        else if (r.outcome === "skipped") this.log("left a recorded agent pid alone", { pid: rec.pid, reason: r.reason });
      }
      fs.rmSync(file, { force: true });
    }
    return results;
  }

  /**
   * Stops one recorded agent group now (the turn watchdog's kill, through
   * AcpProcess.kill): verified first, SIGTERM, grace, SIGKILL. False when
   * the pid isn't recorded here (the caller signals it itself).
   */
  async stop(pid: number): Promise<boolean> {
    const rec = this.agents.get(pid);
    if (!rec || !this.proc) return false;
    const r = await this.stopGroup(rec);
    if (r.outcome === "skipped") return false;
    this.agents.delete(pid);
    this.write();
    return true;
  }

  /** Graceful shutdown: stops what this worker still has recorded and removes its file. */
  async reapOwn(): Promise<ReapResult[]> {
    if (!this.proc) return [];
    const recs = this.records();
    const results = await Promise.all(recs.map((rec) => this.stopGroup(rec)));
    for (const rec of recs) this.agents.delete(rec.pid);
    this.write();
    return results;
  }

  /** Last resort on `process.exit`: SIGKILL every verified own group, synchronously. */
  installExitHook(): void {
    if (this.exitHook || !this.proc) return;
    this.exitHook = () => {
      for (const rec of this.records()) {
        if (verifyRecord(rec, this.proc!).ok) signalGroup(rec.pid, "SIGKILL");
      }
      this.agents.clear();
      try {
        fs.rmSync(this.file, { force: true });
      } catch {
        // best effort
      }
    };
    process.once("exit", this.exitHook);
  }

  uninstallExitHook(): void {
    if (this.exitHook) process.off("exit", this.exitHook);
    this.exitHook = undefined;
  }
}
