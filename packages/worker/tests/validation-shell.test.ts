import { describe, expect, it } from "vitest";
import { validatePlan } from "@/orchestrator/planValidator";

describe("shell file-write rejection (test-app hello.txt regression)", () => {
  it("shell subtask creating a file is rejected so planner falls back to code_change", () => {
    const plan = {
      goal: "Create hello.txt containing 'hello world' in the workspace",
      strategy: "dag",
      requiresApproval: true,
      maxConcurrency: 1,
      subtasks: [
        {
          key: "create-hello-txt",
          title: "Create hello.txt",
          description: "Use shell-execution to create the file. Run exactly this command: printf 'hello world\\n' > hello.txt",
          kind: "shell",
          capability: "shell-execution",
          dependencies: [],
          order: 0,
        },
      ],
    };
    const r = validatePlan(plan, 8);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("shell-execution cannot create/write files");
  });

  it("git-only shell subtask is still accepted", () => {
    const plan = {
      goal: "Check git status",
      strategy: "single",
      subtasks: [
        {
          key: "status",
          title: "Git status",
          description: "Run git status to check workspace state",
          kind: "shell",
          capability: "shell-execution",
          dependencies: [],
          order: 0,
        },
      ],
    };
    const r = validatePlan(plan, 8);
    expect(r.ok).toBe(true);
  });
});
