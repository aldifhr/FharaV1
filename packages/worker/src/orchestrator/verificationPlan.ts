import type { ExecutionPlan } from "@/types";
import { CAPABILITY } from "@/types";

/** A chat-level verification hint must become one QA node, never code work. */
export function verificationPlan(
  plan: ExecutionPlan,
  command: string,
  routingKind: string | undefined,
  qaMode: string | undefined,
  requirementIds: string[] = []
): ExecutionPlan | null {
  if (routingKind !== "testing" || qaMode === "never") return null;
  return {
    ...plan,
    goal: command.slice(0, 500),
    strategy: "single",
    visualQa: /\b(screenshot|responsive|visual|layout)\b/i.test(command),
    subtasks: [
      {
        key: "qa",
        title: "Verify the running app",
        description: `Use http://127.0.0.1:3000 as the local preview when no URL is given. ${command}`,
        kind: "qa",
        capability: CAPABILITY.BROWSER_TESTING,
        dependencies: [],
        requirementIds,
        order: 0,
      },
    ],
  };
}
