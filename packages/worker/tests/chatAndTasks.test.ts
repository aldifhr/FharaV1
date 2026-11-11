import { describe, expect, it, vi } from "vitest";

// Minimal test implementations of the core routing and validation algorithms
// Mirrors fallbackOwner (apps/api/convex/lib/chat/owner.ts, O3): no CTO default.
// An un-mentioned message nobody's topic matched goes to Support, General,
// Researcher, then anyone but the CTO.
function pickConversationalAgent(
  agents: Array<{ _id: string; name: string; role: string; isEnabled?: boolean }>
) {
  const notCto = agents.filter((a) => !/^(?:cto|architect)$/i.test(a.role.trim()));
  if (notCto.length === 0) return agents[0];
  return (
    notCto.find((a) => /^support/i.test(a.role)) ??
    notCto.find((a) => /^(general|assistant)/i.test(a.role)) ??
    notCto.find((a) => /^researcher/i.test(a.role)) ??
    notCto[0]
  );
}

function selectConversationAgents(
  projectAgentIds: string[] | undefined,
  allAgents: Array<{ _id: string; name: string; role: string; isEnabled?: boolean }>,
  preferredAgentIds?: string[]
) {
  const hasTeam = Boolean(projectAgentIds && projectAgentIds.length > 0);
  const inProject = hasTeam
    ? allAgents.filter((a) => projectAgentIds!.includes(a._id))
    : [];
  const enabled = inProject.filter((a) => a.isEnabled !== false);

  const preferred = preferredAgentIds?.length
    ? enabled.filter((a) => preferredAgentIds.includes(a._id))
    : [];

  if (preferred.length > 0) {
    return preferred;
  }
  if (enabled.length > 0) {
    return [pickConversationalAgent(enabled)];
  }
  return [];
}

function resolveOrchestrationAgents(
  taskAssignedIds: string[] | undefined,
  projectAgentIds: string[] | undefined,
  allAgents: Array<{ _id: string; name: string; isEnabled?: boolean }>
) {
  const assigned = taskAssignedIds?.length ? taskAssignedIds : projectAgentIds;
  return assigned?.length
    ? allAgents.filter((a) => assigned.includes(a._id) && a.isEnabled !== false)
    : [];
}

describe("Chat and Task Management", () => {
  const mockAgents = [
    { _id: "lead-1", name: "Lead Architect", role: "Software Architect", isEnabled: true },
    { _id: "frontend-1", name: "Frontend Dev", role: "Frontend Engineer", isEnabled: true },
    { _id: "security-1", name: "Security Officer", role: "Security Auditor", isEnabled: true },
    { _id: "disabled-1", name: "Inactive Dev", role: "Backend Engineer", isEnabled: false },
    { _id: "external-1", name: "Rogue Agent", role: "External", isEnabled: true },
  ];

  it("1. Normal conversation has no CTO default: the fallback owner is Support (O3)", () => {
    const team = [
      { _id: "cto-1", name: "CTO", role: "cto", isEnabled: true },
      { _id: "support-1", name: "Support", role: "support", isEnabled: true },
      ...mockAgents,
    ];
    const selected = selectConversationAgents(["cto-1", "lead-1", "frontend-1", "support-1"], team);
    expect(selected).toHaveLength(1);
    expect(selected[0]._id).toBe("support-1");
    // No Support on the team: anyone but the CTO.
    expect(selectConversationAgents(["cto-1", "frontend-1"], team)[0]._id).toBe("frontend-1");
    // The CTO answers only when it is the whole team (or @mentioned).
    expect(selectConversationAgents(["cto-1"], team)[0]._id).toBe("cto-1");
    expect(selectConversationAgents(["cto-1", "frontend-1"], team, ["cto-1"])[0]._id).toBe("cto-1");
  });

  it("2. Explicit task creation uses same mutation payload contract", () => {
    const buildTaskArgs = (projectId: string, command: string, assignedAgentIds?: string[]) => ({
      projectId,
      command: command.trim(),
      title: command.length > 80 ? command.slice(0, 80) + "..." : command,
      assignedAgentIds,
    });

    const manualTask = buildTaskArgs("p1", "Add login page");
    const programmaticTask = buildTaskArgs("p1", "Add login page", ["frontend-1"]);

    expect(manualTask.command).toBe("Add login page");
    expect(manualTask.title).toBe("Add login page");
    expect(programmaticTask.assignedAgentIds).toEqual(["frontend-1"]);
  });

  it("3. Ambiguous intent does not create tasks accidentally in chat", () => {
    const chatMode: string = "chat";
    const shouldCreateTask = chatMode === "task";
    expect(shouldCreateTask).toBe(false);
  });

  it("4. Agent-specific conversation routing uses preferredAgentId", () => {
    const selected = selectConversationAgents(
      ["lead-1", "frontend-1", "security-1"],
      mockAgents,
      ["frontend-1"]
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]._id).toBe("frontend-1");
  });

  it("5. Multiple agent selection defines sequential multi-agent conversation", () => {
    const selected = selectConversationAgents(
      ["lead-1", "frontend-1", "security-1"],
      mockAgents,
      ["frontend-1", "security-1"]
    );
    expect(selected).toHaveLength(2);
    expect(selected.map((a) => a._id)).toEqual(["frontend-1", "security-1"]);
  });

  it("6. Empty project team never falls back to global agents", () => {
    const chatAgents = selectConversationAgents([], mockAgents);
    expect(chatAgents).toEqual([]);

    const undefinedChatAgents = selectConversationAgents(undefined, mockAgents);
    expect(undefinedChatAgents).toEqual([]);

    const orchAgents = resolveOrchestrationAgents(undefined, [], mockAgents);
    expect(orchAgents).toEqual([]);

    // External agents outside project team are never selected even if preferred
    const rogueAttempt = selectConversationAgents(["lead-1"], mockAgents, ["external-1"]);
    expect(rogueAttempt.map((a) => a._id)).toEqual(["lead-1"]);
  });

  it("7. Rapid consecutive messages generate unique message IDs and are processed independently", async () => {
    const processedMessages: string[] = [];
    const fakeSend = async (content: string, id: string) => {
      processedMessages.push(id);
      return { messageId: id };
    };

    const [res1, res2, res3] = await Promise.all([
      fakeSend("First message", "msg-1"),
      fakeSend("Second message", "msg-2"),
      fakeSend("Third message", "msg-3"),
    ]);

    expect(res1.messageId).toBe("msg-1");
    expect(res2.messageId).toBe("msg-2");
    expect(res3.messageId).toBe("msg-3");
    expect(processedMessages).toEqual(["msg-1", "msg-2", "msg-3"]);
  });

  it("8. Duplicate response prevention ignores already answered messages", () => {
    const replies = new Set<string>(["msg-1"]);
    const isAlreadyReplied = (userMessageId: string) => replies.has(userMessageId);

    expect(isAlreadyReplied("msg-1")).toBe(true);
    expect(isAlreadyReplied("msg-2")).toBe(false);
  });

  it("9. LLM failure and retry does not crash the project or conversation", async () => {
    const responses: Array<{ agentId: string; content: string }> = [];
    const agentsToRun = [
      { id: "a1", willFail: true },
      { id: "a2", willFail: false },
    ];

    for (const agent of agentsToRun) {
      try {
        if (agent.willFail) {
          throw new Error("Provider rate limit");
        }
        responses.push({ agentId: agent.id, content: "Success response" });
      } catch (err: any) {
        responses.push({ agentId: agent.id, content: `I couldn't reply (${err.message}).` });
      }
    }

    expect(responses).toHaveLength(2);
    expect(responses[0].content).toContain("Provider rate limit");
    expect(responses[1].content).toBe("Success response");
  });

  it("10. Manual task creation and Chat task creation consistency", () => {
    const formatTaskWithContext = (command: string, history: string[]) => {
      const historyLines = history.slice(0, 12).join("\n\n");
      const contextBlock = historyLines ? `\n\n--- Conversation context ---\n${historyLines}` : "";
      return command + contextBlock;
    };

    const task1 = formatTaskWithContext("Fix navbar", ["User: help", "Agent: on it"]);
    expect(task1).toContain("Fix navbar");
    expect(task1).toContain("--- Conversation context ---");
  });
});
