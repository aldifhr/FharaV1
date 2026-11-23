import { describe, expect, it, vi } from "vitest";
import { nativeCompletionProvider } from "@/execution/nativeCompletion";
import type { ChatLlmSpawnResult } from "@/tools/chatLlm";

type Spawn = (command: string, argv: string[], stdin: string) => Promise<ChatLlmSpawnResult>;
const spawnWith = (text: string, code = 0) =>
  vi.fn<Spawn>(async () => ({ stdout: text, stderr: "", code }));

describe("nativeCompletionProvider (plan 074)", () => {
  it("runs the selected global model and returns the CLI text verbatim", async () => {
    const spawnImpl = spawnWith('{"verdict":"agree"}');
    const provider = nativeCompletionProvider("opencode/hy4-flash-free", { spawnImpl });
    const result = await provider.complete([
      { role: "system", content: "Answer with strict JSON." },
      { role: "user", content: "Review this diff." },
    ]);
    expect(result.content).toBe('{"verdict":"agree"}');
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [, argv, prompt] = spawnImpl.mock.calls[0];
    expect(argv).toContain("run");
    expect(argv).toContain("-m");
    expect(argv).toContain("opencode/hy4-flash-free");
    expect(prompt).toContain("Answer with strict JSON.");
    expect(prompt).toContain("Review this diff.");
  });

  it("uses the per-call model override when supplied", async () => {
    const spawnImpl = spawnWith("ok");
    const provider = nativeCompletionProvider("opencode/hy4-flash-free", { spawnImpl });
    await provider.complete([{ role: "user", content: "hi" }], "opencode/other");
    expect(spawnImpl.mock.calls[0][1]).toContain("opencode/other");
  });

  it("fails with the CLI error and never invents another model", async () => {
    const spawnImpl = vi.fn<Spawn>(async () => ({ stdout: "", stderr: "model not found", code: 1 }));
    const provider = nativeCompletionProvider("opencode/hy4-flash-free", { spawnImpl });
    await expect(provider.complete([{ role: "user", content: "hi" }])).rejects.toThrow(/model not found/);
    expect(spawnImpl.mock.calls[0][1]).toContain("opencode/hy4-flash-free");
  });

  it("honours an abort signal before the call", async () => {
    const spawnImpl = spawnWith("unused");
    const provider = nativeCompletionProvider("opencode/hy4-flash-free", { spawnImpl });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.complete([{ role: "user", content: "hi" }], undefined, { signal: controller.signal })
    ).rejects.toThrow(/aborted/i);
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
