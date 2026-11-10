import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/** Every file adapted from threadbear names its source and the MIT notice (plan risk 9). */
const SRC = path.resolve(import.meta.dirname, "../../src");
const NOTICES = fs.readFileSync(path.resolve(import.meta.dirname, "../../../../THIRD_PARTY_NOTICES.md"), "utf8");
const COPIED = ["direct/acpSession.ts", "direct/toolGate.ts", "direct/handoff.ts", "direct/codeWrites.ts", "direct/threadRunner.ts"];

function vendored(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? vendored(full) : e.name.endsWith(".ts") ? [full] : [];
  });
}

describe("threadbear attribution", () => {
  const files = [...vendored(path.join(SRC, "vendor/threadbear")), ...COPIED.map((f) => path.join(SRC, f))];
  it.each(files.map((f) => [path.relative(SRC, f), f]))("%s carries the threadbear header and is listed in THIRD_PARTY_NOTICES.md", (rel, file) => {
    const head = fs.readFileSync(file, "utf8").slice(0, 2000);
    expect(head).toContain("github.com/mikecann/threadbear");
    expect(head).toMatch(/MIT License, Copyright \(c\) 2026 Mike Cann|MIT License,\s*Copyright \(c\)\s*2026 Mike Cann/);
    expect(NOTICES).toContain(`packages/worker/src/${rel}`);
  });
  it("the notice has the full MIT text", () => {
    expect(NOTICES).toContain("## threadbear");
    expect(NOTICES).toContain("Copyright (c) 2026 Mike Cann");
    expect(NOTICES).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });
});
