import { describe, expect, it } from "vitest";
import { diagnoseDraftParse, parseDraftLenient, parseFileBlocks, repairJson } from "@/utils/draftLenient";
import { buildRepairPrompt, invalidAnswerEvent, parseCodeChangeAnswer } from "@/execution/agentExecutor";

const FENCE = "```";

describe("lenient code_change parsing", () => {
  it("keeps strict JSON as format json", () => {
    const r = parseDraftLenient('{"files":[{"filePath":"a.js","newContent":"x\\n"}]}');
    expect(r.format).toBe("json");
    expect(r.draft?.files[0]).toEqual({ filePath: "a.js", newContent: "x\n" });
  });

  it("accepts JSON inside ```json fences with leading prose and trailing text", () => {
    const content = `Here is the change:\n${FENCE}json\n{"files":[{"filePath":"src/a.js","newContent":"const a = 1;\\n"}]}\n${FENCE}\nLet me know!`;
    const r = parseDraftLenient(content);
    expect(r.draft?.files).toEqual([{ filePath: "src/a.js", newContent: "const a = 1;\n" }]);
  });

  it("parses FILE: path blocks", () => {
    const content = `FILE: src/header.js\n${FENCE}js\nexport const x = "a\\b";\n${FENCE}\n\nFILE: test/header.test.js\n${FENCE}\nit("works", () => {});\n${FENCE}\n`;
    const r = parseDraftLenient(content);
    expect(r.format).toBe("file-blocks");
    expect(r.draft?.files).toEqual([
      { filePath: "src/header.js", newContent: 'export const x = "a\\b";\n' },
      { filePath: "test/header.test.js", newContent: 'it("works", () => {});\n' },
    ]);
  });

  it("parses ### path headings and **path** and backticked paths", () => {
    const content = `### \`src/a.js\`\n\n${FENCE}javascript\nA\n${FENCE}\n**src/b.css**\n${FENCE}css\nB\n${FENCE}`;
    const r = parseFileBlocks(content);
    expect(r?.files).toEqual([
      { filePath: "src/a.js", newContent: "A\n" },
      { filePath: "src/b.css", newContent: "B\n" },
    ]);
  });

  it("parses ```lang path=... fences and ```path fences", () => {
    const content = `${FENCE}js path=src/a.js\nA\n${FENCE}\n${FENCE}css title="styles/main.css"\nB\n${FENCE}\n${FENCE}src/c.js\nC\n${FENCE}`;
    expect(parseFileBlocks(content)?.files).toEqual([
      { filePath: "src/a.js", newContent: "A\n" },
      { filePath: "styles/main.css", newContent: "B\n" },
      { filePath: "src/c.js", newContent: "C\n" },
    ]);
  });

  it("keeps nested fences in a README (four-backtick and three-backtick outer fence)", () => {
    const readme = `# Demo\n\n## Usage\n\n${FENCE}bash\nnpm test\n${FENCE}\n\nDone.`;
    const four = `FILE: README.md\n\`\`\`\`markdown\n${readme}\n\`\`\`\`\n`;
    expect(parseFileBlocks(four)?.files[0].newContent).toBe(`${readme}\n`);
    const three = `FILE: README.md\n${FENCE}markdown\n${readme}\n${FENCE}\nFILE: src/a.js\n${FENCE}js\nA\n${FENCE}`;
    const files = parseFileBlocks(three)?.files;
    expect(files?.[0].newContent).toBe(`${readme}\n`);
    expect(files?.[1]).toEqual({ filePath: "src/a.js", newContent: "A\n" });
  });

  it("accepts a four-backtick opening closed by three backticks (longcat ULTRA answer)", () => {
    const content = "FILE: index.html\n````\n<html></html>\n```\nFILE: src/main.js\n````\nimport x from \"./x.js\";\n```\n";
    expect(parseFileBlocks(content)?.files).toEqual([
      { filePath: "index.html", newContent: "<html></html>\n" },
      { filePath: "src/main.js", newContent: 'import x from "./x.js";\n' },
    ]);
  });

  it("does not trust an unclosed (cut off) last block", () => {
    expect(parseFileBlocks(`FILE: src/a.js\n${FENCE}js\nconst a = 1;\n`)).toBeNull();
  });

  it("rejects the whole answer when a later block is cut off (no partial change set)", () => {
    const content = `FILE: index.html\n\`\`\`\`\n<html></html>\n\`\`\`\nFILE: src/header.js\n\`\`\`\`\nexport const a = "da`;
    expect(parseFileBlocks(content)).toBeNull();
    expect(diagnoseDraftParse(content)).toMatch(/not closed/);
  });

  it("ignores headings that are not paths", () => {
    expect(parseFileBlocks(`### Usage\n${FENCE}bash\nnpm test\n${FENCE}`)).toBeNull();
  });

  it("repairs raw newlines in strings and trailing commas", () => {
    const broken = '{"files":[{"filePath":"a.js","newContent":"line1\n\tline2\n",},],}';
    const r = parseDraftLenient(broken);
    expect(r.format).toBe("json-repaired");
    expect(r.draft?.files[0]).toEqual({ filePath: "a.js", newContent: "line1\n\tline2\n" });
  });

  it("repairs invalid escapes and unescaped inner quotes", () => {
    const broken = '{"files":[{"filePath":"a.js","newContent":"const s = "hi";\nconst t = \\`x\\`;\n"}]}';
    const r = parseDraftLenient(broken);
    expect(r.draft?.files[0]).toEqual({ filePath: "a.js", newContent: 'const s = "hi";\nconst t = \\`x\\`;\n' });
  });

  it("repairJson leaves trailing-comma-like code inside strings alone", () => {
    const fixed = repairJson('{"a":"f(x, )\n{ b, }",}');
    expect(JSON.parse(fixed)).toEqual({ a: "f(x, )\n{ b, }" });
  });

  it("parses a realistic longcat-style answer (prose + JSON with raw newlines, nested quotes)", () => {
    const content = [
      "I'll add tests for the header component and dark mode toggle.",
      "",
      FENCE + "json",
      "{",
      '  "files": [',
      "    {",
      '      "filePath": "test/header.test.js",',
      '      "newContent": "import { test } from \'node:test\';',
      "import assert from 'node:assert/strict';",
      "import { renderHeader, NAV_LINKS } from '../src/header.js';",
      "",
      "test(\"renders brand\", () => {",
      "  const html = renderHeader();",
      "  assert.ok(html.includes(\"class=\\\"brand\\\"\"));",
      "  assert.equal(NAV_LINKS.length > 0, true);",
      "});",
      '"',
      "    },",
      "  ],",
      '  "findings": ["no test runner configured"]',
      "}",
      FENCE,
      "",
      "These tests cover the header rendering.",
    ].join("\n");
    const r = parseCodeChangeAnswer(content);
    expect(r.draft?.files).toHaveLength(1);
    expect(r.draft?.files[0].filePath).toBe("test/header.test.js");
    expect(r.draft?.files[0].newContent).toContain('test("renders brand", () => {');
    expect(r.draft?.files[0].newContent).toContain('assert.ok(html.includes("class="brand""));');
    expect(r.format).toBe("json-repaired");
  });

  it("parses a realistic longcat-style file-block answer with prose around it", () => {
    const content = [
      "Here are the tests:",
      "",
      "FILE: test/header.test.js",
      "````js",
      "import { test } from 'node:test';",
      "test(\"toggle\", () => { const s = `a\\n${1}`; });",
      "````",
      "",
      '{"findings":["README lacks test section"]}',
    ].join("\n");
    const r = parseCodeChangeAnswer(content);
    expect(r.format).toBe("file-blocks");
    expect(r.draft?.files[0].newContent).toBe("import { test } from 'node:test';\ntest(\"toggle\", () => { const s = `a\\n${1}`; });\n");
  });

  it("diagnoses and scrubs an unparseable answer", () => {
    expect(diagnoseDraftParse("")).toBe("empty answer");
    expect(diagnoseDraftParse("sorry")).toMatch(/no JSON object/);
    expect(diagnoseDraftParse('{"files": [')).toMatch(/not closed/);
    const ev = invalidAnswerEvent("x".repeat(5000));
    expect(ev.answerHead.length).toBe(2048);
    expect(ev.answerChars).toBe(5000);
  });

  it("repair prompt carries only the previous answer and asks for file blocks", () => {
    const p = buildRepairPrompt("PREVIOUS");
    expect(p).toContain("FILE: relative/path/to/file.ext");
    expect(p).toContain("PREVIOUS");
    expect(p).not.toContain("Repository context");
  });
});
