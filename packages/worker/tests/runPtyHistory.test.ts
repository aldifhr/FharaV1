import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runPty, type PtyHandle, type PtySpawnOptions } from "@/tools/runPty";
import { runShellCommand } from "@/execution/shellRun";
import { isCommandAllowed, isInteractiveCommand } from "@/utils/commandAllowlist";
import { BoundedTerminalHistory } from "@/vendor/goat/boundedTerminalHistory";
import { sanitizeTerminalHistoryChunk } from "@/vendor/goat/terminalHistoryReplay";

// GOAT G11: bounded terminal history, query-sequence stripping, tree-kill
// and the allowlist on the PTY path.

interface FakePty extends PtyHandle {
  emitData(chunk: string): void;
  emitExit(code: number): void;
}

function fakePty(script: (pty: FakePty) => void): () => FakePty {
  return () => {
    let dataCb: ((chunk: string) => void) | undefined;
    let exitCb: ((event: { exitCode: number }) => void) | undefined;
    const pty: FakePty = {
      pid: 999_999,
      write() {},
      kill() {},
      onData(cb) {
        dataCb = cb;
        return { dispose: () => undefined };
      },
      onExit(cb) {
        exitCb = cb;
        return { dispose: () => undefined };
      },
      emitData: (chunk) => dataCb?.(chunk),
      emitExit: (code) => exitCb?.({ exitCode: code }),
    };
    setTimeout(() => script(pty), 0);
    return pty;
  };
}

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-pty-g11-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("BoundedTerminalHistory (vendored)", () => {
  it("caps lines, keeping the newest", () => {
    const history = new BoundedTerminalHistory(3, "", 1024);
    history.append("one\ntwo\nthree\nfour\nfive\n");
    expect(history.value()).toBe("three\nfour\nfive\n");
  });

  it("caps UTF-8 bytes without splitting a multibyte character or a surrogate pair", () => {
    const history = new BoundedTerminalHistory(1000, "", 10);
    // "é" = 2 bytes, "日" = 3 bytes, "😀" = 4 bytes (a surrogate pair in UTF-16).
    history.append("é日😀é日😀");
    const value = history.value();
    expect(byteLength(value)).toBeLessThanOrEqual(10);
    expect(value.endsWith("😀")).toBe(true);
    expect(value).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(Buffer.from(value, "utf8").toString("utf8")).toBe(value);
  });

  it("joins a surrogate pair split across two appends", () => {
    const history = new BoundedTerminalHistory(10, "", 64);
    const emoji = "😀";
    history.append(`a${emoji[0]}`);
    history.append(`${emoji[1]}b`);
    expect(history.value()).toBe(`a${emoji}b`);
  });
});

describe("runPty: bounded history", () => {
  it("keeps the newest lines within the line cap and flags truncation", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `línea ${i} 日本 😀`);
    const result = await runPty(root, "npm", ["run", "test"], {
      maxLines: 10,
      spawnImpl: fakePty((pty) => {
        for (const line of lines) pty.emitData(`${line}\r\n`);
        pty.emitExit(0);
      }),
    });
    const kept = result.stdout.split("\n").filter(Boolean);
    expect(kept.length).toBeLessThanOrEqual(10);
    expect(kept.at(-1)).toBe("línea 49 日本 😀");
    expect(result.truncated).toBe(true);
  }, 8_000);

  it("keeps the byte cap with multibyte output, never a broken character", async () => {
    const chunk = "日本語😀".repeat(200); // 10 + 4 bytes per unit
    const result = await runPty(root, "npm", ["run", "build"], {
      maxBytes: 1000,
      spawnImpl: fakePty((pty) => {
        // Split mid surrogate pair on purpose.
        pty.emitData(chunk.slice(0, 501));
        pty.emitData(chunk.slice(501));
        pty.emitExit(0);
      }),
    });
    expect(byteLength(result.stdout)).toBeLessThanOrEqual(1000);
    expect(byteLength(result.stdout)).toBeGreaterThan(900);
    expect(result.stdout.endsWith("😀")).toBe(true);
    expect(result.stdout).not.toMatch(/\ufffd/);
    expect(result.truncated).toBe(true);
  }, 8_000);

  it("is not truncated when everything fits", async () => {
    const result = await runPty(root, "npm", ["run", "test"], {
      spawnImpl: fakePty((pty) => {
        pty.emitData("ok ✓\r\n");
        pty.emitExit(0);
      }),
    });
    expect(result).toMatchObject({ stdout: "ok ✓\n", truncated: false, code: 0 });
  }, 8_000);
});

describe("runPty: terminal query sequences", () => {
  const queries = [
    "\x1b[6n", // DSR cursor position query
    "\x1b[12;40R", // its reply
    "\x1b[c", // DA1
    "\x1b[>0;276;0c", // DA2 reply
    "\x1b[?2026$p", // DECRQM
    "\x1b]11;?\x07", // OSC background colour query
    "\x1bP$qm\x1b\\", // DECRQSS
    "\x1b[>q", // XTVERSION
  ];

  it("the vendored sanitizer drops queries and keeps colour setters, across chunk splits", () => {
    let pending = "";
    let visible = "";
    const stream = `a${queries.join("")}\x1b[31mred\x1b[0mb`;
    for (let i = 0; i < stream.length; i += 3) {
      const out = sanitizeTerminalHistoryChunk(pending, stream.slice(i, i + 3));
      pending = out.pendingControlSequence;
      visible += out.visibleText;
    }
    expect(pending).toBe("");
    expect(visible).toBe("a\x1b[31mred\x1b[0mb");
  });

  it("strips them from the result and from the live stream", async () => {
    const live: string[] = [];
    const result = await runPty(root, "npm", ["run", "test"], {
      onOutput: (text) => live.push(text),
      spawnImpl: fakePty((pty) => {
        pty.emitData(`start${queries[0]}\x1b[`);
        pty.emitData(`32mPASS\x1b[0m ${queries.slice(1).join("")}done\r\n`);
        pty.emitExit(0);
      }),
    });
    expect(result.stdout).toBe("startPASS done\n");
    const joined = live.join("");
    expect(joined).toBe("startPASS done\n");
    expect(joined).not.toMatch(/\x1b|\[6n|11;\?/);
  }, 8_000);
});

describe.skipIf(process.platform === "win32")("runPty: tree-kill on abort (real PTY)", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("kills the PTY process and its children when the task signal aborts", async () => {
    const { spawn } = await import("@lydell/node-pty");
    const pidFile = path.join(root, "child.pid");
    let leader = 0;
    const controller = new AbortController();
    const pending = runPty(root, "npm", ["run", "test"], {
      signal: controller.signal,
      timeoutMs: 60_000,
      spawnImpl: (_command, _args, options: PtySpawnOptions) => {
        const handle = spawn("sh", ["-c", `sleep 30 & echo $! > "${pidFile}"; echo started; wait`], options);
        leader = handle.pid;
        return handle;
      },
    });
    let child = 0;
    for (let i = 0; i < 100 && !child; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      child = Number((await fs.readFile(pidFile, "utf8").catch(() => "")).trim()) || 0;
    }
    expect(child).toBeGreaterThan(0);
    expect(alive(child)).toBe(true);
    controller.abort();
    const result = await pending;
    expect(result.timedOut).toBe(true);
    for (let i = 0; i < 40 && (alive(child) || alive(leader)); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(alive(leader)).toBe(false);
    expect(alive(child)).toBe(false);
  }, 15_000);
});

describe("allowlist on the PTY path", () => {
  it("only allowlisted progress commands are interactive", () => {
    expect(isInteractiveCommand("npm", ["run", "test"])).toBe(true);
    expect(isInteractiveCommand("npx", ["tsc", "--noEmit"])).toBe(true);
    expect(isInteractiveCommand("npm", ["run", "test", "--", "--watch"])).toBe(false);
    expect(isInteractiveCommand("git", ["status"])).toBe(false);
    expect(isInteractiveCommand("bash", ["-c", "npm run test"])).toBe(false);
    expect(isCommandAllowed("npm", ["run", "test;", "rm"])).toBe(false);
  });

  it("runShellCommand refuses a non-allowlisted command and never spawns", async () => {
    let spawned = false;
    await expect(
      runShellCommand(root, "rm", ["-rf", "."], {
        spawnImpl: () => {
          spawned = true;
          return fakePty(() => undefined)();
        },
      })
    ).rejects.toThrow(/not allowlisted/);
    await expect(
      runShellCommand(root, "npm", ["run", "test", "x"], {
        spawnImpl: () => {
          spawned = true;
          return fakePty(() => undefined)();
        },
      })
    ).rejects.toThrow(/not allowlisted/);
    expect(spawned).toBe(false);
  });

  it("routes npm run test through the PTY and streams it to onChunk", async () => {
    const chunks: string[] = [];
    let spawnedArgv: string[] = [];
    const result = await runShellCommand(root, "npm", ["run", "test"], {
      onChunk: (delta) => {
        chunks.push(delta);
      },
      spawnImpl: (command, args) => {
        spawnedArgv = [command, ...args];
        return fakePty((pty) => {
          pty.emitData("\x1b[32m✓\x1b[0m 3 passed\r\n");
          pty.emitExit(1);
        })();
      },
    });
    expect(spawnedArgv).toEqual(["npm", "run", "test"]);
    expect(result.via).toBe("pty");
    expect(result.stdout).toBe("✓ 3 passed\n");
    expect(result.stderr).toBe("(exit code 1)");
    expect(chunks.join("")).toBe("✓ 3 passed\n");
  }, 8_000);

  it("keeps quick commands on runCommand (no PTY spawn)", async () => {
    let spawned = false;
    const result = await runShellCommand(root, "node", ["--version"], {
      spawnImpl: () => {
        spawned = true;
        return fakePty(() => undefined)();
      },
    });
    expect(spawned).toBe(false);
    expect(result.via).toBe("exec");
    expect(result.stdout).toMatch(/^v\d+\./);
  });
});
