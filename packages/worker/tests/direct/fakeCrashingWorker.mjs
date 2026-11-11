#!/usr/bin/env node
// N2 fixture: a "worker" that spawns fakeOrphanAgent.mjs detached (its own
// group, as connection.ts does), reports "agent <pid> <childPid>", and then
// waits to be SIGKILLed by the test.
import { spawn } from "node:child_process";
import path from "node:path";

const agent = spawn(process.execPath, [path.join(import.meta.dirname, "fakeOrphanAgent.mjs"), "acp", "--pure"], {
  detached: true,
  stdio: ["pipe", "pipe", "ignore"],
});
let buf = "";
agent.stdout.on("data", (d) => {
  buf += d.toString();
  const m = /ready (\d+)/.exec(buf);
  if (m) process.stdout.write(`agent ${agent.pid} ${m[1]}\n`);
});
setInterval(() => undefined, 1e6);
