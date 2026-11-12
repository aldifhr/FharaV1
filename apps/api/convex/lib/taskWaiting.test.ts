import { describe, expect, test } from "vitest";
import { isAwaitingUserAnswer } from "./taskWaiting";

describe("isAwaitingUserAnswer", () => {
  test("orchestrated waiting_input always waits on the user", () => {
    expect(isAwaitingUserAnswer({ status: "waiting_input" })).toBe(true);
    expect(isAwaitingUserAnswer({ status: "waiting_input", mode: "orchestrated" })).toBe(true);
  });
  test("a legacy direct thread (removed 2026-11-12) never does", () => {
    expect(isAwaitingUserAnswer({ status: "waiting_input", mode: "direct" })).toBe(false);
  });
  test("other statuses never count", () => {
    expect(isAwaitingUserAnswer({ status: "running" })).toBe(false);
  });
});
