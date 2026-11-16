import { describe, expect, it } from "vitest";

import { truncate } from "./String.ts";

describe("truncate", () => {
  it("cuts by Unicode code point so emoji stay whole", () => {
    expect(truncate("👍👍👍", 5)).toBe("👍👍👍");
    expect(truncate("👍👍👍👍", 3)).toBe("👍👍👍...");
  });

  it("trims before measuring", () => {
    expect(truncate("  hello  ", 5)).toBe("hello");
  });
});
