import { describe, expect, test } from "vitest";
import { isAwaitingUserAnswer } from "./taskWaiting";

describe("isAwaitingUserAnswer", () => {
  test("orchestrated waiting_input always waits on the user", () => {
    expect(isAwaitingUserAnswer({ status: "waiting_input" })).toBe(true);
    expect(isAwaitingUserAnswer({ status: "waiting_input", mode: "orchestrated" })).toBe(true);
  });
  test("an idle direct thread does not; one with a question does", () => {
    expect(isAwaitingUserAnswer({ status: "waiting_input", mode: "direct" })).toBe(false);
    expect(isAwaitingUserAnswer({ status: "waiting_input", mode: "direct", pendingQuestion: "  " })).toBe(false);
    expect(isAwaitingUserAnswer({ status: "waiting_input", mode: "direct", pendingQuestion: "Which file?" })).toBe(true);
  });
  test("other statuses never count", () => {
    expect(isAwaitingUserAnswer({ status: "running", pendingQuestion: "x" })).toBe(false);
  });
});
