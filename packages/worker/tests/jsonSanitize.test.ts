import { describe, expect, it } from "vitest";
import { extractFileHint, sanitizeForChat, stripDelegationJson } from "../src/utils/json";

const SAMPLE = "Design spec for the pricing page. Use a three-column layout.";
const WITH_JSON = `${SAMPLE}\n\n{"delegationRecommendation":{"targetCapability":"browser-testing","reason":"verify breakpoints"},"findings":["tier--popular scale overflow"]}`;

describe("stripDelegationJson", () => {
  it("removes the delegation block and keeps the prose", () => {
    expect(stripDelegationJson(WITH_JSON)).toBe(SAMPLE);
  });
  it("leaves non-delegation JSON untouched", () => {
    const code = 'Config looks like {"files":[]} but is fine';
    expect(stripDelegationJson(code)).toBe(code);
  });
  it("leaves prose without JSON untouched", () => {
    expect(stripDelegationJson(SAMPLE)).toBe(SAMPLE);
  });
});

describe("sanitizeForChat", () => {
  it("caps very long responses", () => {
    const long = "x".repeat(2000);
    expect(sanitizeForChat(long)).toHaveLength(1501);
  });
  it("strips delegation json before capping", () => {
    const out = sanitizeForChat(WITH_JSON);
    expect(out).not.toContain("delegationRecommendation");
    expect(out).toContain("Design spec");
  });
});

describe("extractFileHint", () => {
  it("matches the extension whole: package.json is not truncated to package.js", () => {
    // A DemoApp fix run hinted "/package.js" from this line — a path that does not exist.
    expect(extractFileHint('base the fix on node_modules/<pkg>/package.json "types"')).toBe("package.json");
  });
  it("keeps the directory of the first real path", () => {
    expect(extractFileHint("Perbaiki src/hello.tsx dan render di src/App.tsx")).toBe("src/hello.tsx");
  });
  it("matches another extension, including at the end of a sentence, and no path is null", () => {
    expect(extractFileHint("dokumentasi README.md")).toBe("README.md");
    expect(extractFileHint("lihat README.md.")).toBe("README.md");
    expect(extractFileHint("tidak ada berkas di sini")).toBeNull();
  });
});
