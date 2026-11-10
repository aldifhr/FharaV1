import { describe, expect, it } from "vitest";
import {
  applyEditBlock,
  applyEditBlocks,
  editFailureFeedback,
  findFilename,
  findOriginalUpdateBlocks,
  findSimilarLines,
  hasEditBlocks,
  stripQuotedWrapping,
  tryDotDotDots,
  EditBlockParseError,
} from "@/utils/editBlocks";
import {
  BlockAnchorReplacer,
  IndentationFlexibleReplacer,
  LineTrimmedReplacer,
  WhitespaceNormalizedReplacer,
  replace,
} from "@/utils/editReplacers";
import { resolveEditAnswer } from "@/execution/editAnswer";

const fence = ["```", "```"] as const;

describe("Aider block parser (ported from tests/basic/test_editblock.py)", () => {
  it("find_filename", () => {
    const valid = ["file1.py", "file2.py", "dir/file3.py", "\\windows\\__init__.py"];
    expect(findFilename(["file1.py", "```"], fence, valid)).toBe("file1.py");
    expect(findFilename(["```python", "file3.py", "```"], fence, valid)).toBe("dir/file3.py");
    expect(findFilename(["```", "invalid_file.py", "```"], fence, valid)).toBe("invalid_file.py");
    expect(findFilename(["```python", "file1.py", "```", "```", "file2.py", "```"], fence, valid)).toBe("file2.py");
    expect(findFilename(["# file1.py", "```"], fence, valid)).toBe("file1.py");
    expect(findFilename(["file1_py", "```"], fence, valid)).toBe("file1.py");
    expect(findFilename(["\\windows__init__.py", "```"], fence, valid)).toBe("\\windows\\__init__.py");
  });

  it("strip_quoted_wrapping", () => {
    expect(stripQuotedWrapping("filename.ext\n```\nWe just want this content\nNot the filename and triple quotes\n```", "filename.ext")).toBe(
      "We just want this content\nNot the filename and triple quotes\n"
    );
    expect(stripQuotedWrapping("```\nWe just want this content\nNot the triple quotes\n```")).toBe(
      "We just want this content\nNot the triple quotes\n"
    );
    expect(stripQuotedWrapping("We just want this content\nNot the triple quotes\n")).toBe(
      "We just want this content\nNot the triple quotes\n"
    );
  });

  it("find_original_update_blocks: filename above or below the fence", () => {
    const a = "\nHere's the change:\n\n```text\nfoo.txt\n<<<<<<< SEARCH\nTwo\n=======\nTooooo\n>>>>>>> REPLACE\n```\n\nHope you like it!\n";
    expect(findOriginalUpdateBlocks(a)).toEqual([{ filePath: "foo.txt", search: "Two\n", replace: "Tooooo\n" }]);
    const b = "\nHere's the change:\n\nfoo.txt\n```text\n<<<<<<< SEARCH\nTwo\n=======\nTooooo\n>>>>>>> REPLACE\n```\n\nHope you like it!\n";
    expect(findOriginalUpdateBlocks(b)).toEqual([{ filePath: "foo.txt", search: "Two\n", replace: "Tooooo\n" }]);
  });

  it("find_original_update_blocks: unclosed block and missing filename raise", () => {
    const unclosed = "\nHere's the change:\n\n```text\nfoo.txt\n<<<<<<< SEARCH\nTwo\n=======\nTooooo\n\n\noops!\n";
    expect(() => findOriginalUpdateBlocks(unclosed)).toThrow(EditBlockParseError);
    expect(() => findOriginalUpdateBlocks(unclosed)).toThrow("Expected `>>>>>>> REPLACE` or `=======`");
    const noName = "\nHere's the change:\n\n```text\n<<<<<<< SEARCH\nTwo\n=======\nTooooo\n\n\noops!\n>>>>>>> REPLACE\n";
    expect(() => findOriginalUpdateBlocks(noName)).toThrow("filename");
  });

  it("find_original_update_blocks: no final newline", () => {
    const edit =
      "\naider/coder.py\n<<<<<<< SEARCH\n            self.console.print(\"[red]^C again to quit\")\n=======\n            self.io.tool_error(\"^C again to quit\")\n>>>>>>> REPLACE\n\naider/coder.py\n<<<<<<< SEARCH\n            self.console.print(\"[red]Skipped commit.\")\n=======\n            self.io.tool_error(\"Skipped commit.\")\n>>>>>>> REPLACE";
    expect(findOriginalUpdateBlocks(edit)).toHaveLength(2);
  });

  it("find_original_update_blocks: several blocks for one file, separated by ...", () => {
    const edit = "\nHere's the change:\n\n```text\nfoo.txt\n<<<<<<< SEARCH\none\n=======\ntwo\n>>>>>>> REPLACE\n\n...\n\n<<<<<<< SEARCH\nthree\n=======\nfour\n>>>>>>> REPLACE\n```\n\nHope you like it!\n";
    expect(findOriginalUpdateBlocks(edit)).toEqual([
      { filePath: "foo.txt", search: "one\n", replace: "two\n" },
      { filePath: "foo.txt", search: "three\n", replace: "four\n" },
    ]);
  });

  it("deepseek-coder-v2 filename mangling", () => {
    const edit = "\nHere's the change:\n\n ```python\nfoo.txt\n```\n```python\n<<<<<<< SEARCH\none\n=======\ntwo\n>>>>>>> REPLACE\n```\n\nHope you like it!\n";
    expect(findOriginalUpdateBlocks(edit)).toEqual([{ filePath: "foo.txt", search: "one\n", replace: "two\n" }]);
  });

  it("a new file in the same folder keeps its own name", () => {
    const edit =
      "\nHere's the change:\n\npath/to/a/file2.txt\n```python\n<<<<<<< SEARCH\n=======\nthree\n>>>>>>> REPLACE\n```\n\nanother change\n\npath/to/a/file1.txt\n```python\n<<<<<<< SEARCH\none\n=======\ntwo\n>>>>>>> REPLACE\n```\n\nHope you like it!\n";
    expect(findOriginalUpdateBlocks(edit, fence, ["path/to/a/file1.txt"])).toEqual([
      { filePath: "path/to/a/file2.txt", search: "", replace: "three\n" },
      { filePath: "path/to/a/file1.txt", search: "one\n", replace: "two\n" },
    ]);
  });

  it("quad-backtick fence with triple backticks in the reply", () => {
    const edit = "\nHere's the change:\n\nfoo.txt\n```text\n<<<<<<< SEARCH\n=======\nTooooo\n>>>>>>> REPLACE\n```\n\nHope you like it!\n";
    expect(findOriginalUpdateBlocks(edit, ["````", "````"])).toEqual([{ filePath: "foo.txt", search: "", replace: "Tooooo\n" }]);
  });

  it("sh and csharp language identifiers", () => {
    const sh = "\nHere's a shell script:\n\n```sh\ntest_hello.sh\n<<<<<<< SEARCH\n=======\n#!/bin/bash\necho \"$1\"\nexit 0\n>>>>>>> REPLACE\n```\n";
    const shBlocks = findOriginalUpdateBlocks(sh);
    expect(shBlocks).toHaveLength(1);
    expect(shBlocks[0].filePath).toBe("test_hello.sh");
    expect(shBlocks[0].search).toBe("");
    expect(shBlocks[0].replace).toContain("#!/bin/bash");
    const cs = "\nHere's a C# code change:\n\n```csharp\nProgram.cs\n<<<<<<< SEARCH\nConsole.WriteLine(\"Hello World!\");\n=======\nConsole.WriteLine(\"Hello, C# World!\");\n>>>>>>> REPLACE\n```\n";
    expect(findOriginalUpdateBlocks(cs)).toEqual([
      { filePath: "Program.cs", search: 'Console.WriteLine("Hello World!");\n', replace: 'Console.WriteLine("Hello, C# World!");\n' },
    ]);
  });

  it("plain shell blocks are skipped, not parsed", () => {
    const edit = "Run this:\n```bash\nnpm test\n```\nfoo.txt\n```\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n```\n";
    expect(findOriginalUpdateBlocks(edit)).toEqual([{ filePath: "foo.txt", search: "a\n", replace: "b\n" }]);
    expect(hasEditBlocks(edit)).toBe(true);
    expect(hasEditBlocks("FILE: a.ts\n````\nx\n````")).toBe(false);
  });
});

describe("Aider replace strategies", () => {
  it("missing leading whitespace is restored (Aider test_replace_part_with_missing_leading_whitespace)", () => {
    const whole = "    line1\n    line2\n    line3\n";
    expect(applyEditBlock(whole, { filePath: "f", search: "line1\nline2\n", replace: "new_line1\nnew_line2\n" })).toEqual({
      ok: true,
      content: "    new_line1\n    new_line2\n    line3\n",
    });
  });

  it("varied missing leading whitespace (Aider test_replace_part_with_missing_varied_leading_whitespace)", () => {
    const whole = "\n    line1\n    line2\n        line3\n    line4\n";
    const part = "line2\n    line3\n";
    const repl = "new_line2\n    new_line3\n";
    expect(applyEditBlock(whole, { filePath: "f", search: part, replace: repl })).toEqual({
      ok: true,
      content: "\n    line1\n    new_line2\n        new_line3\n    line4\n",
    });
  });

  it("try_dotdotdots applies each chunk and rejects unpaired dots", () => {
    const whole = "a\nb\nc\nd\ne\n";
    expect(tryDotDotDots(whole, "a\n...\nd\n", "A\n...\nD\n")).toBe("A\nb\nc\nD\ne\n");
    expect(tryDotDotDots(whole, "a\n", "b\n")).toBeNull();
    expect(() => tryDotDotDots(whole, "a\n...\nd\n", "A\nD\n")).toThrow("Unpaired");
  });

  it("find_similar_lines returns the closest chunk", () => {
    const content = "def foo():\n    return 1\n\ndef bar():\n    return 2\n";
    expect(findSimilarLines("    return 1\n\ndef bar():\n    return 3\n", content)).toContain("def bar():");
    expect(findSimilarLines("completely unrelated text here", "x\ny\n")).toBe("");
  });
});

describe("opencode replacers (copied from v1.0.0 tool/edit.ts)", () => {
  const content = "function a() {\n  const x = 1\n  return x\n}\n\nfunction b() {\n  const y = 2\n  return y\n}\n";

  it("exact unique replacement", () => {
    expect(replace(content, "const y = 2", "const y = 3")).toContain("const y = 3");
  });

  it("line-trimmed match ignores per-line indentation differences", () => {
    expect([...LineTrimmedReplacer(content, "const x = 1\nreturn x")]).toEqual(["  const x = 1\n  return x"]);
    expect(replace(content, "const x = 1\nreturn x", "  const x = 10\n  return x")).toContain("const x = 10");
  });

  it("block anchor match tolerates a changed middle line", () => {
    const found = [...BlockAnchorReplacer(content, "function b() {\n  const y = 20\n  return y\n}")];
    expect(found).toEqual(["function b() {\n  const y = 2\n  return y\n}"]);
  });

  it("whitespace-normalized and indentation-flexible matches", () => {
    expect([...WhitespaceNormalizedReplacer("let   a =  1;\n", "let a = 1;")]).toContain("let   a =  1;");
    expect([...IndentationFlexibleReplacer("    if (x) {\n      y()\n    }\n", "if (x) {\n  y()\n}")]).toEqual([
      "    if (x) {\n      y()\n    }",
    ]);
  });

  it("refuses an ambiguous multi-match and a missing string", () => {
    const twice = "x = 1\nx = 1\n";
    expect(() => replace(twice, "x = 1", "x = 2")).toThrow(/multiple matches/);
    expect(replace(twice, "x = 1", "x = 2", true)).toBe("x = 2\nx = 2\n");
    expect(() => replace(content, "not here at all", "z")).toThrow(/not found/);
    expect(() => replace(content, "same", "same")).toThrow(/must be different/);
  });
});

describe("applyEditBlocks / feedback", () => {
  const files: Record<string, string> = {
    "src/a.ts": "export const a = 1;\nexport const b = 2;\nexport const a2 = 1;\n",
    "src/dup.ts": "x();\ny();\nx();\n",
  };
  const read = async (p: string) => files[p] ?? null;

  it("applies blocks in order and creates new files from an empty SEARCH", async () => {
    const result = await applyEditBlocks(
      [
        { filePath: "src/a.ts", search: "export const b = 2;\n", replace: "export const b = 3;\n" },
        { filePath: "src/new.ts", search: "", replace: "export const n = 0;\n" },
      ],
      read
    );
    expect(result.failures).toEqual([]);
    expect(result.files).toEqual([
      { filePath: "src/a.ts", newContent: "export const a = 1;\nexport const b = 3;\nexport const a2 = 1;\n", isNew: false },
      { filePath: "src/new.ts", newContent: "export const n = 0;\n", isNew: true },
    ]);
  });

  it("refuses an ambiguous match with the candidate line numbers", async () => {
    const result = await applyEditBlocks([{ filePath: "src/dup.ts", search: "x();\n", replace: "z();\n" }], read);
    expect(result.files).toEqual([]);
    expect(result.failures[0]).toMatchObject({ kind: "ambiguous", lines: [1, 3] });
    const text = editFailureFeedback(result.failures, 0);
    expect(text).toContain("matches at lines 1, 3");
  });

  it("a miss yields a did-you-mean report; a missing file is its own failure", async () => {
    const result = await applyEditBlocks(
      [
        { filePath: "src/a.ts", search: "export const b = 2;\nexport const a2 = 1;\nextra line\n", replace: "export const b = 9;\n" },
        { filePath: "src/gone.ts", search: "x\n", replace: "y\n" },
        { filePath: "src/a.ts", search: "export const a = 1;\n", replace: "export const a = 5;\n" },
      ],
      read
    );
    expect(result.applied).toHaveLength(1);
    expect(result.failures.map((f) => f.kind)).toEqual(["no_match", "missing_file"]);
    const text = editFailureFeedback(result.failures, result.applied.length);
    expect(text).toContain("# 2 SEARCH/REPLACE blocks failed to match!");
    expect(text).toContain("SearchReplaceNoExactMatch");
    expect(text).toContain("Did you mean to match some of these actual lines from src/a.ts?");
    expect(text).toContain("The other 1 SEARCH/REPLACE block were applied successfully.");
  });

  it("resolveEditAnswer keeps a Format B new file next to edit blocks", async () => {
    const answer = [
      "src/a.ts",
      "```ts",
      "<<<<<<< SEARCH",
      "export const b = 2;",
      "=======",
      "export const b = 4;",
      ">>>>>>> REPLACE",
      "```",
      "",
      "FILE: src/brand-new.ts",
      "````",
      "export const fresh = true;",
      "````",
    ].join("\n");
    const resolved = await resolveEditAnswer(answer, read);
    expect(resolved.used).toBe(true);
    expect(resolved.failures).toEqual([]);
    expect(resolved.files.map((f) => f.filePath)).toEqual(["src/a.ts", "src/brand-new.ts"]);
    expect(resolved.files[0].newContent).toContain("export const b = 4;");
  });
});
