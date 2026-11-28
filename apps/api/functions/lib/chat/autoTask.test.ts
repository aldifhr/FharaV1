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

describe("autoTask: work-shaped messages create a task, addressed or not", () => {
  it("creates for a change request and a run request", () => {
    expect(shouldAutoCreateTask({ ...base, workShaped: true })).toBe(true);
    expect(shouldAutoCreateTask({ ...base, runRequest: true })).toBe(true);
  });

  it("does not create for chat-only messages", () => {
    expect(shouldAutoCreateTask(base)).toBe(false);
  });

  it("keeps a work-shaped task when the To picker addressed an agent", () => {
    expect(shouldAutoCreateTask({ ...base, workShaped: true, mentionCount: 1 })).toBe(true);
  });

  it("never overrides an @mention on a chat-only message, an option pick or pasted text", () => {
    expect(shouldAutoCreateTask({ ...base, mentionCount: 1 })).toBe(false);
    expect(shouldAutoCreateTask({ ...base, workShaped: true, optionPick: true })).toBe(false);
    expect(shouldAutoCreateTask({ ...base, workShaped: true, pasted: true })).toBe(false);
  });

  it("respects the project opt-out", () => {
    expect(shouldAutoCreateTask({ ...base, workShaped: true, autoCreateChatTasks: false })).toBe(false);
    expect(shouldAutoCreateTask({ ...base, workShaped: true, autoCreateChatTasks: true })).toBe(true);
  });
});
