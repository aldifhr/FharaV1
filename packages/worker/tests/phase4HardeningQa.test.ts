import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runResponsiveQa } from "@/execution/qa";

/**
 * Phase 4 hardening — mandatory regression test 12: cancelling QA
 * kills the WHOLE dev-server process tree.
 *
 * The fixture workspace's `npm run dev` starts an observable fake dev
 * server (server.js) which itself spawns a child process (child.js);
 * both write their pids to files and stay alive. The QA base URL
 * points at a port nothing listens on, so QA is still in its
 * server-startup wait when the cancellation lands — the abort path
 * must tear down npm → sh → server → child, leaving no orphans.
 */

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

async function readPid(file: string): Promise<number> {
  const text = await fs.readFile(file, "utf8");
  return Number(text.trim());
}

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-p4h-qa-"));
  await fs.writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({
      name: "qa-fixture",
      private: true,
      scripts: { dev: "node server.js" },
    })
  );
  await fs.writeFile(
    path.join(workspace, "server.js"),
    [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      'fs.writeFileSync("server.pid", String(process.pid));',
      'const child = spawn(process.execPath, ["child.js"], { stdio: "ignore" });',
      'fs.writeFileSync("child-spawned.pid", String(child.pid));',
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n")
  );
  await fs.writeFile(
    path.join(workspace, "child.js"),
    [
      'const fs = require("node:fs");',
      'fs.writeFileSync("child.pid", String(process.pid));',
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n")
  );
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("QA process-tree cleanup (mandatory test 12)", () => {
  it(
    "test 12: cancelling QA kills the dev server and its child process — no orphans",
    async () => {
      const controller = new AbortController();
      const qaPromise = runResponsiveQa(workspace, {
        baseUrl: "http://127.0.0.1:34567",
        signal: controller.signal,
      });

      // Both observable processes come up and are alive.
      const up = await waitFor(
        async () =>
          (await fs
            .access(path.join(workspace, "child.pid"))
            .then(() => true)
            .catch(() => false)) &&
          (await fs
            .access(path.join(workspace, "server.pid"))
            .then(() => true)
            .catch(() => false)),
        10_000
      );
      expect(up).toBe(true);
      const serverPid = await readPid(path.join(workspace, "server.pid"));
      const childPid = await readPid(path.join(workspace, "child.pid"));
      expect(isAlive(serverPid)).toBe(true);
      expect(isAlive(childPid)).toBe(true);

      // Cancel mid-run (QA is waiting for the server to become
      // reachable at an unused port; it never will).
      controller.abort();
      const report = await qaPromise;
      expect(report.verdict).toBe("failed");

      // The whole tree dies: the dev server AND its spawned child.
      const treeDead = await waitFor(
        () => !isAlive(serverPid) && !isAlive(childPid),
        5_000
      );
      expect(treeDead).toBe(true);
      expect(isAlive(serverPid)).toBe(false);
      expect(isAlive(childPid)).toBe(false);
    },
    30_000
  );
});
