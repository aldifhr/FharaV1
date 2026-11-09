import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runPty, stripAnsi, type PtyHandle, type PtySpawnOptions } from "@/tools/runPty";

interface FakePty extends PtyHandle {
  written: string[];
  killed: boolean;
  spawnOptions?: PtySpawnOptions;
  emitData(chunk: string): void;
  emitExit(code: number): void;
}

function createFakePty(): FakePty {
  let dataCb: ((chunk: string) => void) | undefined;
  let exitCb: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const pendingData: string[] = [];
  let pendingExit: number | null = null;
  const fake: FakePty = {
    pid: 4242,
    written: [],
    killed: false as boolean,
    write(data: string) {
      fake.written.push(data);
    },
    kill() {
      fake.killed = true;
    },
    onData(cb: (chunk: string) => void) {
      dataCb = cb;
      for (const chunk of pendingData.splice(0)) cb(chunk);
      return { dispose: () => undefined };
    },
    onExit(cb: (event: { exitCode: number; signal?: number }) => void) {
      exitCb = cb;
      if (pendingExit !== null) {
        const code = pendingExit;
        pendingExit = null;
        cb({ exitCode: code });
      }
      return { dispose: () => undefined };
    },
    emitData(chunk: string) {
      if (dataCb) dataCb(chunk);
      else pendingData.push(chunk);
    },
    emitExit(code: number) {
      if (exitCb) exitCb({ exitCode: code });
      else pendingExit = code;
    },
  };
  return fake;
}

describe("runPty gates", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-pty-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refuses a non-allowlisted command before spawning", async () => {
    let spawned = false;
    await expect(
      runPty(root, "rm", ["-rf", "."], {
        spawnImpl: () => {
          spawned = true;
          return createFakePty();
        },
      })
    ).rejects.toThrow(/not allowlisted/);
    expect(spawned).toBe(false);
  });

  it("refuses prefix-bypass args before spawning", async () => {
    let spawned = false;
    await expect(
      runPty(root, "npm", ["run", "test", "evil"], {
        spawnImpl: () => {
          spawned = true;
          return createFakePty();
        },
      })
    ).rejects.toThrow(/not allowlisted/);
    expect(spawned).toBe(false);
  });

  it("refuses when the signal is already aborted", async () => {
    let spawned = false;
    const controller = new AbortController();
    controller.abort();
    await expect(
      runPty(root, "node", ["--version"], {
        signal: controller.signal,
        spawnImpl: () => {
          spawned = true;
          return createFakePty();
        },
      })
    ).rejects.toThrow(/aborted/);
    expect(spawned).toBe(false);
  });

  it("refuses scripted input with control characters", async () => {
    let spawned = false;
    await expect(
      runPty(root, "node", ["--version"], {
        input: "\x1b[2J",
        spawnImpl: () => {
          spawned = true;
          return createFakePty();
        },
      })
    ).rejects.toThrow(/control/);
    expect(spawned).toBe(false);
  });

  it("spawns in the resolved workspace root and captures stripped output", async () => {
    const fake = createFakePty();
    setTimeout(() => {
      fake.emitData("\x1b[32mhello\x1b[0m\r\n");
      fake.emitData("progress 10%\rprogress 100%\r\n");
      fake.emitExit(0);
    }, 0);

    const result = await runPty(root, "node", ["--version"], {
      input: "y\r",
      spawnImpl: (_command, _args, options) => {
        fake.spawnOptions = options;
        return fake;
      },
    });

    expect(result).toEqual({
      stdout: "hello\nprogress 100%\n",
      stderr: "",
      code: 0,
      timedOut: false,
      truncated: false,
    });
    expect(fake.written).toEqual(["y\r"]);
    expect((await fs.realpath(root)).toLowerCase()).toBe(
      fake.spawnOptions?.cwd.toLowerCase()
    );
    expect(fake.spawnOptions?.name).toBe("xterm-256color");
    expect(fake.spawnOptions?.cols).toBe(80);
  }, 8_000);

  it("kills the tree on timeout and reports timedOut", async () => {
    const fake = createFakePty();
    const result = await runPty(root, "node", ["--version"], {
      timeoutMs: 1_000,
      spawnImpl: () => fake,
    });
    expect(result.timedOut).toBe(true);
    expect(fake.killed).toBe(true);
  }, 8_000);

  it("kills the tree when the task signal aborts mid-run", async () => {
    const fake = createFakePty();
    const controller = new AbortController();
    const pending = runPty(root, "node", ["--version"], {
      signal: controller.signal,
      timeoutMs: 60_000,
      spawnImpl: () => fake,
    });
    setTimeout(() => controller.abort(), 10);
    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(fake.killed).toBe(true);
  }, 8_000);
});

describe("stripAnsi", () => {
  it("removes CSI and OSC sequences", () => {
    expect(stripAnsi("\x1b[1mBold\x1b[0m plain")).toBe("Bold plain");
    expect(stripAnsi("\x1b]0;title\x07after")).toBe("after");
  });

  it("keeps only the final segment of a carriage-return line", () => {
    expect(stripAnsi("a\rprogress\r done")).toBe(" done");
    expect(stripAnsi("keep\nold\rnew")).toBe("keep\nnew");
    expect(stripAnsi("spinner 10%\rspinner 100%\r\n")).toBe("spinner 100%\n");
    expect(stripAnsi("a\r\rb")).toBe("b");
  });
});
