import { describe, expect, it } from "vitest";
import { makeUnifiedDiff } from "@/tools/gitDiff";

describe("makeUnifiedDiff", () => {
  it("emits only the changed lines with context, not a whole-file rewrite", () => {
    const oldContent = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n") + "\n";
    const newContent = ["1", "2", "3", "4", "FIVE", "6", "7", "8", "9", "10"].join("\n") + "\n";
    expect(makeUnifiedDiff("f.ts", oldContent, newContent)).toBe(
      ["--- a/f.ts", "+++ b/f.ts", "@@ -2,7 +2,7 @@", " 2", " 3", " 4", "-5", "+FIVE", " 6", " 7", " 8"].join("\n")
    );
  });

  it("splits distant changes into separate hunks", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `l${index}`);
    const changed = [...lines];
    changed[1] = "X";
    changed[25] = "Y";
    const diff = makeUnifiedDiff("f.ts", lines.join("\n") + "\n", changed.join("\n") + "\n");
    expect(diff.match(/^@@/gm)).toHaveLength(2);
  });

  it("handles a new file and an insertion at the end", () => {
    expect(makeUnifiedDiff("n.ts", "", "a\nb\n")).toBe(["--- a/n.ts", "+++ b/n.ts", "@@ -0,0 +1,2 @@", "+a", "+b"].join("\n"));
    expect(makeUnifiedDiff("e.ts", "a\n", "a\nb\n")).toBe(["--- a/e.ts", "+++ b/e.ts", "@@ -1,1 +1,2 @@", " a", "+b"].join("\n"));
  });
});
