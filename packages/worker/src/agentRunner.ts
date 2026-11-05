import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createProviderForAgent, type AgentLLMConfig } from "./llm";
import { readFile } from "./tools/readFile";
import { writeFile } from "./tools/writeFile";
import { runCommand } from "./tools/runCommand";
import { computeDiff, writeStaged, type FileDiff } from "./tools/gitDiff";
import { waitForApproval } from "./approvalGate";

export interface RunContext {
  taskId: string;
  projectId: string;
  workspacePath: string;
  command: string;
  orchestrationPlan?: string;
  agents: ({ _id: string; name: string; role: string; systemPrompt?: string } & AgentLLMConfig)[];
  // ponytail: callbacks di-inject dari index.ts agar agentRunner testable tanpa Convex.
  onChunk: (agentId: string, delta: string) => Promise<void>;
  onEvent: (type: string, payload: Record<string, unknown>) => Promise<void>;
  requestApproval: (kind: "apply_changes" | "git_push" | "run_command", summary: string, payload: unknown, requestedByAgentId?: string) => Promise<string>;
  waitApproval: (approvalId: string) => Promise<{ status: "approved" | "rejected" | "pending" }>;
  saveFileChange: (fc: FileDiff) => Promise<string>;
  updateTaskStatus: (status: string) => Promise<void>;
  setAgentStatus: (agentId: string, status: string) => Promise<void>;
}

function findAgent(agents: RunContext["agents"], role: string) {
  return agents.find((a) => a.role.trim().toLowerCase() === role);
}

export async function runTask(ctx: RunContext) {
  const ws = ctx.workspacePath;
  await fs.mkdir(path.resolve(ws), { recursive: true });

  const frontend = findAgent(ctx.agents, "frontend");
  const cto = findAgent(ctx.agents, "cto");
  const qa = findAgent(ctx.agents, "qa");
  if (!frontend) throw new Error("Frontend agent not found");
  const providerFor = (agent: RunContext["agents"][number]) =>
    createProviderForAgent(agent);

  await ctx.setAgentStatus(frontend._id, "working");

  // 1. Frontend: draft perubahan lewat LLM (sederhana: minta edit satu file)
  const fileHint = extractFileHint(ctx.command);
  const draft = await providerFor(frontend).complete([
    ...(frontend.systemPrompt ? [{ role: "system" as const, content: frontend.systemPrompt }] : []),
    {
      role: "user",
      content: `Orchestrator plan:\n${ctx.orchestrationPlan ?? "(none)"}\n\nCommand: ${ctx.command}\nTarget file hint: ${fileHint ?? "(explore)"}\nReturn JSON: { "filePath": "...", "newContent": "..." } only.`,
    },
  ]);

  const parsed = parseDraft(draft.content);
  if (!parsed) {
    await ctx.onEvent("agent.error", { message: "Frontend draft parse failed" });
    await ctx.updateTaskStatus("failed");
    return;
  }

  const diff = await computeDiff(ws, parsed.filePath, parsed.newContent);
  const fcId = await ctx.saveFileChange(diff);
  await ctx.onEvent("fileChanges.updated", { fileChanges: [fcId] });
  await ctx.onEvent("task.status", { status: "running" });

  // 2. CTO review
  let ctoVerdict = "Approved";
  if (cto) {
    await ctx.setAgentStatus(cto._id, "working");
    const review = await providerFor(cto).stream!(
      [
        ...(cto.systemPrompt ? [{ role: "system" as const, content: cto.systemPrompt }] : []),
        { role: "user", content: `Orchestrator plan:\n${ctx.orchestrationPlan ?? "(none)"}\n\nDiff:\n${diff.diff}\n\nVerdict?` },
      ],
      async (delta) => {
        await ctx.onChunk(cto._id, delta);
      }
    );
    ctoVerdict = review.content.includes("Changes requested") ? "Changes requested" : "Approved";
    await ctx.setAgentStatus(cto._id, "idle");
  }

  if (ctoVerdict !== "Approved") {
    await ctx.onEvent("task.status", { status: "done", note: "CTO requested changes" });
    await ctx.setAgentStatus(frontend._id, "idle");
    return;
  }

  // 3. QA checks
  if (qa) {
    await ctx.setAgentStatus(qa._id, "working");
    for (const size of ["1440px", "768px", "375px"]) {
      await ctx.onEvent("task.check", { agentId: qa._id, label: size, status: "running" });
      try {
        await runCommand(ws, "npm", ["run", "build"]);
        await ctx.onEvent("task.check", { agentId: qa._id, label: size, status: "clean" });
      } catch {
        await ctx.onEvent("task.check", { agentId: qa._id, label: size, status: "failed" });
      }
    }
    await ctx.setAgentStatus(qa._id, "idle");
  }

  // 4. Approval gate — STOP sebelum apply
  await ctx.updateTaskStatus("needs_approval");
  await ctx.setAgentStatus(frontend._id, "needs_you");
  await ctx.onEvent("task.status", { status: "needs_approval" });

  const approvalId = await ctx.requestApproval(
    "apply_changes",
    `Apply changes to ${diff.filePath}`,
    { fileChanges: [fcId], diff: diff.diff },
    frontend._id
  );

  const decision = await waitForApproval(async () => {
    const d = await ctx.waitApproval(approvalId);
    return { status: d.status as any };
  });

  if (decision.status !== "approved") {
    await ctx.updateTaskStatus("rejected");
    await ctx.onEvent("task.status", { status: "rejected" });
    await ctx.setAgentStatus(frontend._id, "idle");
    return;
  }

  // 5. Apply staged (sekarang baru tulis permanen)
  await writeStaged(ws, diff);
  await ctx.updateTaskStatus("done");
  await ctx.onEvent("task.status", { status: "done" });
  await ctx.setAgentStatus(frontend._id, "idle");
}

function extractFileHint(command: string): string | null {
  const m = command.match(/[\w./-]+\.(tsx?|jsx?|css|html)/i);
  return m ? m[0] : null;
}

function parseDraft(content: string): { filePath: string; newContent: string } | null {
  for (let start = content.indexOf("{"); start >= 0; start = content.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < content.length; index += 1) {
      const character = content[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === "\"") {
          inString = false;
        }
        continue;
      }
      if (character === "\"") {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth !== 0) continue;

        const candidate = content.slice(start, index + 1);
        try {
          const parsed: unknown = JSON.parse(candidate);
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "filePath" in parsed &&
            "newContent" in parsed
          ) {
            const draft = parsed as { filePath: unknown; newContent: unknown };
            if (typeof draft.filePath === "string" && typeof draft.newContent === "string") {
              return { filePath: draft.filePath, newContent: draft.newContent };
            }
          }
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        break;
      }
    }
  }
  return null;
}
