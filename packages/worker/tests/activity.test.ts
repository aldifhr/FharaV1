import { describe, expect, it } from "vitest";
import { createActivityReporter, describeActivity } from "../src/services/runner/activity";

describe("describeActivity", () => {
  it("describes reads, commands, checks and writes", () => {
    expect(describeActivity("agent.context", { readPaths: ["a.ts", "b.ts"] })).toBe("Reading 2 files: a.ts, b.ts");
    expect(describeActivity("shell.command", { command: "npm", args: ["test"] })).toBe("Running npm test");
    expect(describeActivity("task.check", { label: "desktop viewport", status: "passed" })).toBe("Checking desktop viewport: passed");
    expect(describeActivity("file.staged", { filePath: "src/lib/utils.ts" })).toBe("Writing src/lib/utils.ts");
    expect(describeActivity("agent.context", { retry: true })).toBe("Model answer was invalid, retrying");
  });
  it("ignores unknown events and clips long text", () => {
    expect(describeActivity("task.stage", {})).toBeNull();
    expect(describeActivity("shell.command", { command: "x".repeat(300) })!.length).toBeLessThanOrEqual(120);
  });
});

describe("createActivityReporter", () => {
  it("skips repeats and swallows write errors", async () => {
    const writes: string[] = [];
    const report = createActivityReporter(async (a) => {
      writes.push(a);
      if (a === "boom") throw new Error("x");
    });
    report("Starting");
    report("Starting");
    report(null);
    report("boom");
    report("Waiting for the model");
    await new Promise((r) => setTimeout(r, 10));
    expect(writes).toEqual(["Starting", "boom", "Waiting for the model"]);
  });
});
