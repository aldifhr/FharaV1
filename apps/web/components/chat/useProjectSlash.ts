"use client";

/**
 * Project chat slash commands (Paradev C2/C3, plan audit/paradev-plan-2026-11-11.md
 * P-C). `runSlash` turns a sent "/command …" draft into its action and returns
 * true when it handled it. `/research <question>` is an explicit command like
 * `/task`: it creates the research task with the raw "/research …" line, so
 * the worker fan-out runs unchanged (never without a question). A skill
 * ("/<skill> [request]") is not handled here: `skillFor` gives the
 * `invokedSkills` the normal send path adds, so O3 routing (the topic owner)
 * is unchanged and the routed owner carries the skill. `slashEntries` feeds
 * the composer's "/" menu: project builtins, then this team's skills.
 */
import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/api/convex/_generated/api";
import { roleLabel } from "@/lib/agentRoles";
import { skillInvocation, skillsUsedBy, slashMenuEntries } from "@/lib/slashMenu";
import type { PermissionMode } from "@/api/convex/lib/permissionModes";
import { useToast } from "../Toasts";

type TeamAgent = { _id: string; role: string };

export function useProjectSlash({
  projectId,
  agents,
  permissionMode,
  conversationId,
  pendingItems,
  mentions,
  createTask,
  sendMessage,
  setChatError,
  onSelectTask,
}: {
  projectId: string;
  agents: TeamAgent[];
  permissionMode: PermissionMode;
  conversationId?: string;
  pendingItems: any[];
  mentions: { attachMentionedFiles: (text: string) => Promise<string>; mentionedAgentIds: (text: string) => string[] };
  createTask: (args: any) => Promise<unknown>;
  sendMessage: (args: any) => Promise<unknown>;
  setChatError: (error: string) => void;
  onSelectTask: (taskId: string) => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const createMemory = useMutation(api.memories.create);
  const allSkills = useQuery(api.skills.list, {});

  const slashEntries = useMemo(
    () => slashMenuEntries("project", skillsUsedBy((allSkills ?? []) as any[], agents.map((a) => a._id))),
    [allSkills, agents],
  );

  const agentByRole = (...roles: string[]) => roles.map((r) => agents.find((a) => a.role === r)).find(Boolean);

  /** Slash commands. Returns true when the draft was handled. */
  const runSlash = async (text: string): Promise<boolean> => {
    const match = text.match(/^\/(task|research|memory|qa|review|push)\b\s*([\s\S]*)$/i);
    if (!match) return false;
    const command = match[1].toLowerCase();
    const rest = match[2].trim();
    if (command === "task") {
      if (!rest) {
        setChatError("Describe the task after /task.");
        return true;
      }
      const content = await mentions.attachMentionedFiles(rest);
      const assignees = mentions.mentionedAgentIds(content);
      const taskId = await createTask({
        projectId: projectId as never,
        permissionMode,
        command: content,
        ...(assignees.length ? { assignedAgentIds: assignees as never[] } : {}),
        ...(conversationId ? { conversationId } : {}),
      });
      toast("success", "Task created", rest.slice(0, 80));
      onSelectTask(taskId as string);
      return true;
    }
    if (command === "research") {
      if (!rest) {
        setChatError("Ask a question after /research.");
        return true;
      }
      const taskId = await createTask({
        projectId: projectId as never,
        permissionMode,
        command: `/research ${rest}`,
        ...(conversationId ? { conversationId } : {}),
      });
      toast("success", "Research started", rest.slice(0, 80));
      onSelectTask(taskId as string);
      return true;
    }
    if (command === "memory") {
      // No note: open this project's Memory page.
      if (!rest) {
        router.push(`/memory?project=${encodeURIComponent(String(projectId))}`);
        return true;
      }
      await createMemory({
        scope: "project",
        projectId: projectId as never,
        title: rest.replace(/\s+/g, " ").slice(0, 60).trim(),
        content: rest,
        pinned: true,
      });
      toast("success", "Remembered", rest.slice(0, 80));
      return true;
    }
    if (command === "push") {
      const push = pendingItems.find((a: any) => a.kind === "git_push");
      if (push) onSelectTask(push.taskId);
      else toast("info", "No push is waiting", "A push shows up here once a task branch is ready.");
      return true;
    }
    const agent = command === "qa" ? agentByRole("qa") : agentByRole("reviewer");
    if (!agent) {
      setChatError(`No ${command === "qa" ? "QA" : "reviewer"} on this project's team.`);
      return true;
    }
    const content =
      rest || (command === "qa" ? "Please QA the latest change and report what you checked." : "Please review the latest change and call out any risks.");
    await sendMessage({ projectId: projectId as any, content: `@${roleLabel(agent.role)} ${content}`, preferredAgentIds: [agent._id] as any, permissionMode });
    return true;
  };

  /** "/<skill> [request]" → `{ invokedSkills }` for messages.send; else null. */
  const skillFor = (text: string) => skillInvocation(text, slashEntries);

  return { runSlash, skillFor, slashEntries };
}
