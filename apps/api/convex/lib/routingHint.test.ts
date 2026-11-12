import { describe, expect, test } from "vitest";
import { MAX_HINT_FILES, buildRoutingHint, hintFiles, hintRole, readRoutingHint } from "./routingHint";

describe("hintFiles", () => {
  test("paths and bare file names, in order, de-duplicated", () => {
    expect(hintFiles("ubah src/lib/a.ts dan bold.html, lalu src/lib/a.ts lagi")).toEqual(["src/lib/a.ts", "bold.html"]);
    expect(hintFiles("lihat ./apps/web/ dan `README.md`.")).toEqual(["apps/web/", "README.md"]);
  });

  test("URLs and plain words are not files", () => {
    expect(hintFiles("baca https://example.com/docs/page.html dan www.x.y/z")).toEqual([]);
    expect(hintFiles("buatkan halaman login yang menarik")).toEqual([]);
  });

  test("at most MAX_HINT_FILES", () => {
    const text = Array.from({ length: 12 }, (_, i) => `f${i}.ts`).join(" ");
    expect(hintFiles(text)).toHaveLength(MAX_HINT_FILES);
    expect(hintFiles(text)[0]).toBe("f0.ts");
  });
});

describe("hintRole", () => {
  test("one of the fixed role keys, else undefined", () => {
    expect(hintRole("Frontend")).toBe("frontend");
    expect(hintRole("qa")).toBe("qa");
    expect(hintRole("chef")).toBeUndefined();
    expect(hintRole(undefined)).toBeUndefined();
    expect(hintRole(null)).toBeUndefined();
  });
});

describe("buildRoutingHint", () => {
  test("keeps what chat knows and drops empty fields", () => {
    expect(
      buildRoutingHint({
        source: "offer",
        role: "Frontend",
        domain: "frontend",
        topic: "  apps/web/page.tsx  ",
        kind: "implementation",
        brief: "  I'll add a page.  ",
        text: "buatkan apps/web/page.tsx",
      })
    ).toEqual({
      source: "offer",
      role: "frontend",
      domain: "frontend",
      topic: "apps/web/page.tsx",
      kind: "implementation",
      brief: "I'll add a page.",
      files: ["apps/web/page.tsx"],
    });
    expect(buildRoutingHint({ source: "command", role: null, domain: null, kind: null, brief: "  ", text: "halo" })).toEqual({ source: "command" });
  });

  test("the CTO is never a hint's role; an unknown role is dropped", () => {
    expect(buildRoutingHint({ source: "route", role: "cto" }).role).toBeUndefined();
    expect(buildRoutingHint({ source: "route", role: "chef" }).role).toBeUndefined();
  });

  test("kind 'other' is not a kind; hard only when true", () => {
    expect(buildRoutingHint({ source: "offer", kind: "other" }).kind).toBeUndefined();
    expect(buildRoutingHint({ source: "mention", hard: true }).hard).toBe(true);
    expect(buildRoutingHint({ source: "offer", hard: false })).not.toHaveProperty("hard");
  });

  test("brief and topic are capped", () => {
    const hint = buildRoutingHint({ source: "offer", brief: "b".repeat(500), topic: "t".repeat(500) });
    expect(hint.brief).toHaveLength(300);
    expect(hint.topic).toHaveLength(120);
  });
});

describe("readRoutingHint", () => {
  test("a stored hint reads back; junk and unknown sources are null", () => {
    expect(readRoutingHint({ source: "offer", role: "frontend" })).toEqual({ source: "offer", role: "frontend" });
    expect(readRoutingHint({ source: "llm" })).toBeNull();
    expect(readRoutingHint({ role: "frontend" })).toBeNull();
    expect(readRoutingHint(null)).toBeNull();
    expect(readRoutingHint("offer")).toBeNull();
  });
});
