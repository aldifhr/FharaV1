import { describe, expect, it } from "vitest";
import { alreadyDoneFiles } from "../src/services/runner/terminal";

const noop = (file: string) => `No effective change: ${file} would be identical to the current content. Make the requested edit or report why none is needed.`;

describe("alreadyDoneFiles (a no-op run ends done, not failed)", () => {
  it("only No effective change failures and nothing staged: the files already up to date", () => {
    const state = { feedback: [`implement (attempt 1): ${noop("index.html")}`, `implement: ${noop("index.html, docs/a.md")}`, "The implementation produced no file changes"], fileChanges: new Map() };
    expect(alreadyDoneFiles(state)).toEqual(["index.html", "docs/a.md"]);
  });
  it("any other failure, a staged change, or a verify-fix terminal failure: not a no-op", () => {
    expect(alreadyDoneFiles({ feedback: [`implement: ${noop("a.ts")}`, "review: boom"], fileChanges: new Map() })).toBeNull();
    expect(alreadyDoneFiles({ feedback: [`implement: ${noop("a.ts")}`], fileChanges: new Map([["b.ts", {}]]) })).toBeNull();
    expect(alreadyDoneFiles({ feedback: [`fix_verify_1: ${noop("a.ts")}`], fileChanges: new Map(), terminalFailure: "Verification fix changed nothing" })).toBeNull();
    expect(alreadyDoneFiles({ feedback: ["The implementation produced no file changes"], fileChanges: new Map() })).toBeNull();
    expect(alreadyDoneFiles({ feedback: [], fileChanges: new Map() })).toBeNull();
  });
});
