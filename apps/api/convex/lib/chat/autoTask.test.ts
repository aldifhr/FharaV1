import { describe, expect, it } from "vitest";
import { shouldAutoCreateTask, type AutoTaskInput } from "./autoTask";

const base: AutoTaskInput = {
  workShaped: false,
  runRequest: false,
  optionPick: false,
  pasted: false,
  mentionCount: 0,
  autoCreateChatTasks: undefined,
};

describe("autoTask: only work-shaped, unaddressed messages create a task", () => {
  it("creates for a change request and a run request", () => {
    expect(shouldAutoCreateTask({ ...base, workShaped: true })).toBe(true);
    expect(shouldAutoCreateTask({ ...base, runRequest: true })).toBe(true);
  });

  it("does not create for chat-only messages", () => {
    expect(shouldAutoCreateTask(base)).toBe(false);
  });

  it("never overrides an @mention, an option pick or pasted text", () => {
    expect(shouldAutoCreateTask({ ...base, workShaped: true, mentionCount: 1 })).toBe(false);
    expect(shouldAutoCreateTask({ ...base, workShaped: true, optionPick: true })).toBe(false);
    expect(shouldAutoCreateTask({ ...base, workShaped: true, pasted: true })).toBe(false);
  });

  it("respects the project opt-out", () => {
    expect(shouldAutoCreateTask({ ...base, workShaped: true, autoCreateChatTasks: false })).toBe(false);
    expect(shouldAutoCreateTask({ ...base, workShaped: true, autoCreateChatTasks: true })).toBe(true);
  });
});
