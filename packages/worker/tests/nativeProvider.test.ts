import { describe, expect, it } from "vitest";
import {
  NATIVE_PROMPT_MESSAGE,
  nativeArgv,
  parseNativeUsage,
  runNativeProvider,
  killTree,
  buildNativePrompt,
  type SpawnImpl,
} from "@/execution/nativeProvider";
import { spawnReturning } from "./helpers/spawn";

describe("nativeProvider", () => {
  it("builds the provider-native invocation as exact argv", () => {
    const { command, args } = nativeArgv("opencode", ["do the thing"]);
    expect(command).toBe("opencode");
    expect(args).toBeInstanceOf(Array);
    expect(args[0]).toBe("run");
  });

  it("builds a prompt with role, task, and boundaries", () => {
    const prompt = buildNativePrompt({
      title: "Fix bug",
      description: "Fix timeout",
      command: "fix the timeout",
      systemPrompt: "You are Frontend",
      fileContext: "src/index.ts",
    });
    expect(prompt).toContain("Frontend");
    expect(prompt).toContain("fix the timeout");
    expect(prompt).toContain("src/index.ts");
    expect(prompt).toMatch(/full workspace access/i);
  });

  it("parses JSON usage fields from CLI output", () => {
    const stdout = [
      JSON.stringify({ type: "step", usage: { input_tokens: 100, output_tokens: 50 } }),
      JSON.stringify({ type: "done", tokens: { input: 20, output: 10 } }),
      "plain log line",
    ].join("\n");
    expect(parseNativeUsage(stdout)).toEqual({ inputTokens: 120, outputTokens: 60 });
    expect(parseNativeUsage("no json here")).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("runs the provider and surfaces a completed result with usage", async () => {
    const events: string[] = [];
    const spawnImpl: SpawnImpl = async () => ({
      stdout: JSON.stringify({ usage: { input_tokens: 5, output_tokens: 3 } }),
      stderr: "",
      code: 0,
    });
    const result = await runNativeProvider({
      workspacePath: "D:\\work",
      prompt: "do it",
      spawnImpl,
      onEvent: async (type) => {
        events.push(type);
      },
    });
    expect(result.status).toBe("completed");
    expect(result.inputTokens).toBe(5);
    expect(result.outputTokens).toBe(3);
    // O1: the scoped home announces itself (which login was copied).
    expect(events).toEqual(["native.run.started", "native.home", "native.run.finished"]);
  });

  it("reports a failed run on nonzero exit", async () => {
    const spawnImpl: SpawnImpl = spawnReturning({ stderr: "boom", code: 1 });
    const result = await runNativeProvider({
      workspacePath: "D:\\work",
      prompt: "do it",
      spawnImpl,
    });
    expect(result.status).toBe("failed");
    expect(result.output).toContain("boom");
  });

  it("never puts the prompt in argv (Windows command-line limit)", async () => {
    const bigPrompt = "x".repeat(50_000);
    let seenArgs: string[] = [];
    const spawnImpl: SpawnImpl = async (_command, args) => {
      seenArgs = args;
      return { stdout: "", stderr: "", code: 0 };
    };
    const result = await runNativeProvider({
      workspacePath: "D:\\work",
      prompt: bigPrompt,
      spawnImpl,
    });
    expect(result.status).toBe("completed");
    expect(seenArgs[0]).toBe("run");
    const msgAt = seenArgs.indexOf(NATIVE_PROMPT_MESSAGE);
    expect(msgAt).toBeGreaterThan(0);
    expect(seenArgs[msgAt + 1]).toBe("-f");
    expect(seenArgs[msgAt + 2]).toMatch(/prompt\.md$/);
    expect(seenArgs.join(" ")).not.toContain(bigPrompt);
  });

  it("killTree never throws for a child without a pid", () => {
    expect(() => killTree({ pid: undefined } as never)).not.toThrow();
  });

  it("reports spawn errors as failed runs", async () => {
    const spawnImpl: SpawnImpl = async () => {
      throw new Error("ENOENT");
    };
    const result = await runNativeProvider({
      workspacePath: "D:\\work",
      prompt: "do it",
      spawnImpl,
    });
    expect(result.status).toBe("failed");
    expect(result.output).toContain("failed to spawn");
  });
});
