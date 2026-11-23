import { describe, expect, test } from "vitest";
import { sandboxInstructionSpan, unwrapSandboxBrief } from "./lib/sandboxBrief";
import { extractRequirementsFallback } from "./lib/requirements";

/** Live tests 3/4: requirements come from the user's instruction, with file names kept whole. */

const BRIEF =
  'Sandbox experiment "counter" (isolated from production, Auto-accept edits mode).\n' +
  "Instruction: Buat simple.html + style.css + script.js dengan counter. Tambahkan tombol reset.\n" +
  "Guardrails: do not touch production code paths or secrets; never push to a remote or open a PR. Advisory time box: 30 minutes.\n" +
  "Changes stay in this worktree until the run passes its acceptance checks; then they are merged automatically.";

describe("sandbox brief", () => {
  test("only the instruction is the request; guardrail lines are not requirements", () => {
    const request = unwrapSandboxBrief(BRIEF);
    expect(request).toBe("Buat simple.html + style.css + script.js dengan counter. Tambahkan tombol reset.");
    const span = sandboxInstructionSpan(BRIEF)!;
    expect(BRIEF.slice(span.start, span.end)).toBe(request);
    const texts = extractRequirementsFallback(request).map((r) => r.text);
    expect(texts).toEqual(["Buat simple.html + style.css + script.js dengan counter", "Tambahkan tombol reset"]);
  });

  test("a command that is not a brief is unchanged", () => {
    expect(unwrapSandboxBrief("tambahkan tombol")).toBe("tambahkan tombol");
    expect(sandboxInstructionSpan("tambahkan tombol")).toBeNull();
  });
});
