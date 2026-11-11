// N2 (agent process reaping): the registry of ACP agent process groups, the
// boot sweep after a worker died, and the checks that keep it from killing
// anything it didn't spawn. Every process signalled here is one this test
// started; nothing is killed by name.
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPidRegistry, linuxProc, verifyRecord, type AgentPidRecord, type AgentPidsFile, type ProcReader } from "@/direct/agentPids";
import { AcpProcess, silentLogger } from "@/vendor/threadbear/acp/connection";

const HERE = import.meta.dirname;
const linux = process.platform === "linux" && fs.existsSync("/proc/self/stat");

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fhara-n2-"));
  tmpDirs.push(dir);
  return dir;
}

// Only pids/groups this test spawned; cleaned up whatever a test left.
const ownGroups = new Set<number>();
const ownChildren: ChildProcess[] = [];
afterEach(() => {
  for (const pgid of ownGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // gone
    }
  }
  ownGroups.clear();
  for (const c of ownChildren.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const alive = (pid: number) => linuxProc.startTime(pid) !== null; // zombies count as gone
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await sleep(25);
  }
  return true;
}

function readLine(child: ChildProcess, re: RegExp): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error(`no line matching ${re} (got ${JSON.stringify(buf)})`)), 10_000);
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = re.exec(buf);
      if (m) {
        clearTimeout(t);
        resolve(m);
      }
    });
  });
}

/** A detached sleeper in its own group: stands in for an unrelated process. */
async function sleeper(tag: string): Promise<ChildProcess> {
  const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)", tag], { detached: true, stdio: "ignore" });
  ownChildren.push(c);
  ownGroups.add(c.pid!);
  await until(() => alive(c.pid!));
  return c;
}

async function deadPid(): Promise<number> {
  const c = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise((r) => c.once("exit", r));
  return c.pid!;
}

function writeOwnerFile(dir: string, owner: AgentPidsFile["owner"], agents: AgentPidRecord[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${owner.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, owner, agents } satisfies AgentPidsFile));
  return file;
}

describe.skipIf(!linux)("agent process reaping (real processes)", () => {
  it("reaps the group of an agent whose worker was SIGKILLed: leader and its child", async () => {
    const dir = tmp();
    const worker = spawn(process.execPath, [path.join(HERE, "fakeCrashingWorker.mjs")], { stdio: ["ignore", "pipe", "ignore"] });
    ownChildren.push(worker);
    const [, agentStr, childStr] = await readLine(worker, /agent (\d+) (\d+)/);
    const agentPid = Number(agentStr);
    const mcpPid = Number(childStr);
    ownGroups.add(agentPid);
    // What connection.ts's processHooks do in the dead worker.
    new AgentPidRegistry({ dir, ownerPid: worker.pid! }).spawned(agentPid, { args: ["acp", "--pure"], label: "task1" });
    const file = path.join(dir, `${worker.pid}.json`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    // The worker dies without closing anything; the agent lives on.
    worker.kill("SIGKILL");
    await new Promise((r) => worker.once("exit", r));
    await sleep(200);
    expect(alive(agentPid)).toBe(true);
    expect(alive(mcpPid)).toBe(true);

    // The next worker boots and sweeps.
    const results = await new AgentPidRegistry({ dir }).sweep();
    expect(results).toEqual([expect.objectContaining({ pid: agentPid, outcome: "reaped" })]);
    expect(await until(() => !alive(agentPid) && !alive(mcpPid))).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  }, 20_000);

  it("never signals a recorded pid now held by an unrelated process (start time or command line differs)", async () => {
    const dir = tmp();
    const other = await sleeper("fhara-n2-unrelated");
    const pid = other.pid!;
    const real = linuxProc.startTime(pid)!;
    const owner = { pid: await deadPid(), startTime: "1" };
    writeOwnerFile(dir, owner, [
      // pid reused: the recorded agent started at another time
      { pid, startTime: String(Number(real) - 5), cmdline: "opencode\0acp\0--pure", args: ["acp", "--pure"], spawnedAt: 0 },
    ]);
    let results = await new AgentPidRegistry({ dir }).sweep();
    expect(results).toEqual([expect.objectContaining({ pid, outcome: "skipped", reason: expect.stringMatching(/start time/) })]);
    expect(alive(pid)).toBe(true);

    writeOwnerFile(dir, owner, [
      // same start time, but not the agent's command line
      { pid, startTime: real, cmdline: "opencode\0acp\0--pure", args: ["acp", "--pure"], spawnedAt: 0 },
    ]);
    results = await new AgentPidRegistry({ dir }).sweep();
    expect(results).toEqual([expect.objectContaining({ pid, outcome: "skipped", reason: expect.stringMatching(/command line/) })]);
    expect(alive(pid)).toBe(true);
  });

  it("leaves a live worker's agents alone (another checkout running side by side)", async () => {
    const dir = tmp();
    const liveWorker = await sleeper("fhara-n2-live-worker");
    const agent = await sleeper("fhara-n2-agent acp --pure");
    const file = writeOwnerFile(dir, { pid: liveWorker.pid!, startTime: linuxProc.startTime(liveWorker.pid!) }, [
      { pid: agent.pid!, startTime: linuxProc.startTime(agent.pid!)!, cmdline: linuxProc.cmdline(agent.pid!)!, args: [], spawnedAt: 0 },
    ]);
    expect(await new AgentPidRegistry({ dir }).sweep()).toEqual([]);
    expect(alive(agent.pid!)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("records the agent AcpProcess spawns and drops it when it exits", async () => {
    const dir = tmp();
    const reg = new AgentPidRegistry({ dir });
    const proc = new AcpProcess({
      binary: process.execPath,
      args: [path.join(HERE, "fakeAcpAgent.mjs")],
      env: { PATH: process.env.PATH },
      cwd: dir,
      log: silentLogger,
      label: "t-n2",
      timings: { closeWaitMs: 500 },
      processHooks: reg,
    });
    await proc.start();
    const [rec] = reg.records();
    expect(rec).toMatchObject({ label: "t-n2", args: [path.join(HERE, "fakeAcpAgent.mjs")] });
    ownGroups.add(rec.pid);
    expect(rec.cmdline).toContain("fakeAcpAgent.mjs");
    expect(verifyRecord(rec, linuxProc).ok).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(reg.file, "utf8")) as AgentPidsFile;
    expect(onDisk.owner.pid).toBe(process.pid);
    expect(onDisk.agents.map((a) => a.pid)).toEqual([rec.pid]);
    await proc.close();
    expect(await until(() => reg.records().length === 0)).toBe(true);
    expect(fs.existsSync(reg.file)).toBe(false);
  }, 15_000);

  it("graceful shutdown stops whatever this worker still has recorded", async () => {
    const dir = tmp();
    const reg = new AgentPidRegistry({ dir, graceMs: 500 });
    const agent = await sleeper("fhara-n2-agent acp --pure");
    reg.spawned(agent.pid!, { args: ["acp", "--pure"] });
    const results = await reg.reapOwn();
    expect(results).toEqual([expect.objectContaining({ pid: agent.pid, outcome: "reaped" })]);
    expect(await until(() => !alive(agent.pid!))).toBe(true);
    expect(fs.existsSync(reg.file)).toBe(false);
  });
});

describe("verifyRecord (fake /proc)", () => {
  type P = { start: string; cmd: string; pgid: number };
  function fake(procs: Record<number, P>): ProcReader {
    return {
      startTime: (pid) => procs[pid]?.start ?? null,
      cmdline: (pid) => procs[pid]?.cmd ?? null,
      pgid: (pid) => procs[pid]?.pgid ?? null,
      groupMembers: (pgid) =>
        Object.entries(procs)
          .filter(([, p]) => p.pgid === pgid)
          .map(([pid, p]) => ({ pid: Number(pid), startTime: p.start })),
    };
  }
  const rec: AgentPidRecord = { pid: 500, startTime: "1000", cmdline: "/bin/opencode\0acp\0--pure", args: ["acp", "--pure"], spawnedAt: 0 };

  it("accepts the leader it recorded, and an exec wrapper that kept the arguments", () => {
    expect(verifyRecord(rec, fake({ 500: { start: "1000", cmd: rec.cmdline, pgid: 500 }, 501: { start: "1002", cmd: "mcp", pgid: 500 } }))).toEqual({ ok: true, members: [500, 501] });
    expect(verifyRecord(rec, fake({ 500: { start: "1000", cmd: "/real/opencode\0acp\0--pure", pgid: 500 } })).ok).toBe(true);
  });

  it("refuses a reused pid, another command, a non-leader, and pid 1 or itself", () => {
    expect(verifyRecord(rec, fake({ 500: { start: "2000", cmd: rec.cmdline, pgid: 500 } }))).toMatchObject({ ok: false, reason: expect.stringMatching(/start time/) });
    expect(verifyRecord(rec, fake({ 500: { start: "1000", cmd: "vim\0notes", pgid: 500 } }))).toMatchObject({ ok: false, reason: expect.stringMatching(/command line/) });
    expect(verifyRecord(rec, fake({ 500: { start: "1000", cmd: rec.cmdline, pgid: 400 } }))).toMatchObject({ ok: false, reason: expect.stringMatching(/leader/) });
    expect(verifyRecord({ ...rec, pid: 1 }, fake({})).ok).toBe(false);
    expect(verifyRecord({ ...rec, pid: process.pid }, fake({})).ok).toBe(false);
  });

  it("a leaderless group is reaped only when every member started after the agent", () => {
    expect(verifyRecord(rec, fake({ 501: { start: "1003", cmd: "mcp", pgid: 500 } }))).toEqual({ ok: true, members: [501] });
    expect(verifyRecord(rec, fake({ 501: { start: "900", cmd: "mcp", pgid: 500 } }))).toMatchObject({ ok: false });
    expect(verifyRecord(rec, fake({}))).toEqual({ ok: false, reason: "gone" });
    // ps-based systems can't list a group: left alone
    expect(verifyRecord(rec, { ...fake({}), groupMembers: () => null })).toMatchObject({ ok: false });
  });

  it("keeps a record while the exited leader's group still has members", () => {
    const procs: Record<number, P> = { 500: { start: "1000", cmd: rec.cmdline, pgid: 500 }, 501: { start: "1001", cmd: "mcp", pgid: 500 } };
    const reg = new AgentPidRegistry({ dir: tmp(), proc: fake(procs), ownerPid: 42 });
    reg.spawned(500, { args: rec.args });
    delete procs[500];
    reg.exited(500);
    expect(reg.records().map((r) => r.pid)).toEqual([500]);
    delete procs[501];
    reg.exited(500);
    expect(reg.records()).toEqual([]);
  });

  it("does nothing where the OS can't be read (Windows)", async () => {
    const reg = new AgentPidRegistry({ dir: tmp(), proc: null });
    reg.spawned(123, { args: [] });
    expect(reg.records()).toEqual([]);
    expect(await reg.sweep()).toEqual([]);
  });
});
