#!/usr/bin/env node
// N2 fixture: an agent that outlives its worker the way OpenCode does. It
// ignores stdin EOF and SIGHUP, and starts a child in its own process group
// (an MCP server stand-in). Prints "ready <childPid>" once the child runs.
import { spawn } from "node:child_process";

process.on("SIGHUP", () => undefined);
process.stdin.on("error", () => undefined);
process.stdout.on("error", () => undefined);
const child = spawn(process.execPath, ["-e", "process.on('SIGHUP',()=>{});setInterval(()=>{},1e6)", "fhara-n2-mcp-child"], { stdio: "ignore" });
child.on("spawn", () => {
  try {
    process.stdout.write(`ready ${child.pid}\n`);
  } catch {
    // the worker is gone
  }
});
setInterval(() => undefined, 1e6);
