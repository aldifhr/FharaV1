import { describe, expect, test } from "vitest";
import { firstReasoningSentence, intentLineFor, stripInternalPhrasing, toolStepFor } from "./activity";

describe("stripInternalPhrasing", () => {
  test("drops leaked '— skipped: … add when:' lines", () => {
    const text = "Rencana:\n- Backend: tambah endpoint\n- Security — skipped: no auth change; add when: login is added\n- QA: cek form";
    expect(stripInternalPhrasing(text)).toBe("Rencana:\n- Backend: tambah endpoint\n- QA: cek form");
  });
  test("leaves normal text alone", () => {
    expect(stripInternalPhrasing("Tests were skipped in CI.")).toBe("Tests were skipped in CI.");
  });
});

describe("intent line", () => {
  test("classifier intent in the user's language", () => {
    expect(intentLineFor({ intent: "ask", subtype: "debugging" }, "kenapa build ini gagal?")).toBe("Mencari penyebab masalahnya.");
    expect(intentLineFor({ intent: "ask", subtype: "explanation" }, "How does routing work?")).toMatch(/^Tracing/);
    expect(intentLineFor({ intent: "task", subtype: "other" }, "tolong buat halaman login")).toBe("Menyusun rencana kerja.");
  });
  test("first reasoning sentence only when complete, clean and same language", () => {
    expect(firstReasoningSentence("I need to check how the router resolves agents. Then", "How does routing work?")).toBe(
      "I need to check how the router resolves agents."
    );
    expect(firstReasoningSentence("I need to check", "How does routing work?")).toBeNull();
    expect(firstReasoningSentence('I will call {"tool":"grep"} now.', "How does it work?")).toBeNull();
    expect(firstReasoningSentence("I need to check how the router works.", "gimana cara kerja router ini?")).toBeNull();
  });
});

describe("toolStepFor", () => {
  test("captures targets and read ranges", () => {
    expect(toolStepFor({ tool: "read_file", args: { path: "src/a.ts", start: 10, lines: 20 } }, true, 1)).toEqual({
      tool: "read_file", target: "src/a.ts", lines: "10–29", ok: true, at: 1,
    });
    expect(toolStepFor({ tool: "grep", args: { pattern: "foo" } }, false, 2)).toMatchObject({ target: "foo", ok: false });
    expect(toolStepFor({ tool: "list_files", args: {} }, true, 3)).toMatchObject({ target: "." });
    expect(toolStepFor({ tool: "load_skill", args: { name: "deploy" } }, true, 4)).toMatchObject({ target: "deploy" });
  });
});
