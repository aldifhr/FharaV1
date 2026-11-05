import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyFileChange, computeDiff, StaleFileError } from "../src/tools/gitDiff";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-changes-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("file change staging", () => {
  it("stages and applies a new file", async () => {
    const change = await computeDiff(root, "src/new.ts", "export const value = 1;\n");
    expect(change.changeType).toBe("new");
    expect(change.oldContentHash).toBeTruthy();
    expect(change.newContentHash).toBeTruthy();

    await applyFileChange(root, change);
    expect(await fs.readFile(path.join(root, "src/new.ts"), "utf-8")).toBe(
      "export const value = 1;\n"
    );
  });

  it("is idempotent when the new content is already applied", async () => {
    const change = await computeDiff(root, "file.txt", "hello");
    await applyFileChange(root, change);
    await expect(applyFileChange(root, change)).resolves.toBeUndefined();
  });

  it("applies modifications and detects stale content", async () => {
    await fs.writeFile(path.join(root, "file.txt"), "one", "utf-8");
    const change = await computeDiff(root, "file.txt", "two");
    expect(change.changeType).toBe("modified");

    await fs.writeFile(path.join(root, "file.txt"), "someone else", "utf-8");
    await expect(applyFileChange(root, change)).rejects.toBeInstanceOf(StaleFileError);
  });

  it("refuses to overwrite a file created after approval", async () => {
    const change = await computeDiff(root, "later.txt", "proposed");
    await fs.writeFile(path.join(root, "later.txt"), "unexpected", "utf-8");
    await expect(applyFileChange(root, change)).rejects.toBeInstanceOf(StaleFileError);
  });

  it("refuses to delete a file that changed after approval", async () => {
    await fs.writeFile(path.join(root, "gone.txt"), "old", "utf-8");
    const change = await computeDiff(root, "gone.txt", "old");
    await fs.writeFile(path.join(root, "gone.txt"), "new", "utf-8");
    await expect(
      applyFileChange(root, {
        ...change,
        changeType: "deleted",
        newContent: undefined,
        newContentHash: undefined,
      })
    ).rejects.toBeInstanceOf(StaleFileError);
  });
});
