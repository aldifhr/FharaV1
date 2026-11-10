import { describe, expect, it } from "vitest";
import { toAgentDefinition } from "@/services/runner/setup";
import type { WorkerRunAgent } from "@/workerApi";

const base = {
  _id: "a1",
  name: "Backend",
  role: "backend",
  status: "idle",
  isEnabled: true,
  systemPrompt: "static prompt",
  memorySection: "## Memory\n### Package manager\nUse pnpm.",
} as unknown as WorkerRunAgent;

describe("recalled memory in the agent prompt (plan L4)", () => {
  it("appends the recalled section after the pinned one; the prefix is byte-identical", () => {
    const without = toAgentDefinition(base).systemPrompt!;
    const withRecall = toAgentDefinition({
      ...base,
      recalledMemorySection: "## Recalled memory\n### Compaction\nThreshold 80%.",
    } as WorkerRunAgent).systemPrompt!;
    expect(withRecall.startsWith(without)).toBe(true);
    expect(withRecall.slice(without.length)).toBe("\n\n## Recalled memory\n### Compaction\nThreshold 80%.");
  });

  it("no recall leaves the prompt unchanged", () => {
    expect(toAgentDefinition(base).systemPrompt).toBe("static prompt\n\n## Memory\n### Package manager\nUse pnpm.");
  });
});
