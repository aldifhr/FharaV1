import dotenv from "dotenv";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../apps/api/convex/_generated/api";
import { createConvexClient } from "./convexClient";
import { runTask } from "./agentRunner";
import { createProviderForAgent, type AgentLLMConfig } from "./llm";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const POLL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const client = createConvexClient();
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? "./workspaces";
  console.log(`[worker] listening, convex=${process.env.NEXT_PUBLIC_CONVEX_URL}, root=${workspaceRoot}`);
  const recovered = await client.mutation(api.tasks.recoverRunning, {});
  if (recovered > 0) {
    console.warn(`[worker] marked ${recovered} interrupted task(s) as failed`);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let activeTaskId: string | null = null;
    let activeAgentId: string | null = null;
    try {
      const task = await client.mutation(api.tasks.claimNextQueued as any, {});
      if (task) {
        activeTaskId = task._id;
        console.log(`[worker] picked task ${task._id}: ${task.title}`);
        const data = await client.action(api.tasks.getForWorker as any, {
          taskId: task._id,
          workerToken: process.env.CONVEX_SERVICE_TOKEN!,
        });
        if (!data?.project) {
          throw new Error("Project not found for task");
        }

        const wsPath = path.isAbsolute(data.project.workspacePath)
          ? data.project.workspacePath
          : path.resolve(workspaceRoot, data.project.workspacePath);

        const planningAgent = data.agents.find((agent: { role: string }) => agent.role === "orchestrator")
          ?? data.agents.find((agent: { role: string }) => agent.role === "cto")
          ?? data.agents[0];
        if (!planningAgent) {
          throw new Error("No agents are assigned to this project");
        }
        if (isGreeting(data.task.command)) {
          await client.mutation(api.messages.appendAgentChunk as any, {
            projectId: data.project._id,
            taskId: task._id,
            agentId: planningAgent._id,
            delta: "Hello! I am ready to help. Describe the coding change or task you would like me to work on.",
          });
          await client.mutation(api.tasks.updateStatus, { taskId: task._id, status: "done" });
          await client.mutation(api.taskEvents.log as any, {
            taskId: task._id,
            projectId: data.project._id,
            type: "task.status",
            payload: { status: "done", stage: "conversation" },
          });
          continue;
        }
        await client.mutation(api.agents.updateStatus, { agentId: planningAgent._id, status: "working" });
        activeAgentId = planningAgent._id;
        await client.mutation(api.taskEvents.log as any, {
          taskId: task._id,
          projectId: data.project._id,
          type: "task.stage",
          payload: { stage: "thinking", agentId: planningAgent._id, message: `${planningAgent.name} is preparing a plan` },
        });
        const orchestration = await createProviderForAgent(planningAgent as AgentLLMConfig).complete([
          ...(planningAgent.systemPrompt ? [{ role: "system" as const, content: planningAgent.systemPrompt }] : []),
          {
            role: "user",
            content: `Create a concise execution plan for this task using these roles: ${data.agents.map((agent: { role: string }) => agent.role).join(", ")}.\nTask: ${data.task.command}`,
          },
        ]);
        await client.mutation(api.agents.updateStatus, { agentId: planningAgent._id, status: "idle" });
        activeAgentId = null;
        await client.mutation(api.taskEvents.log as any, {
          taskId: task._id,
          projectId: data.project._id,
          type: "task.stage",
          payload: { stage: "planned", agentId: planningAgent._id },
        });

        await runTask({
          taskId: task._id,
          projectId: data.project._id,
          workspacePath: wsPath,
          command: data.task.command,
          orchestrationPlan: orchestration.content,
          agents: data.agents,
          onChunk: async (agentId, delta) => {
            await client.mutation(api.messages.appendAgentChunk as any, {
              projectId: data.project._id,
              taskId: task._id,
              agentId,
              delta,
            });
          },
          appendMessage: async (agentId, content) => {
            await client.mutation(api.messages.appendAgentChunk as any, {
              projectId: data.project._id,
              taskId: task._id,
              agentId,
              delta: content,
            });
          },
          onEvent: async (type, payload) => {
            await client.mutation(api.taskEvents.log as any, {
              taskId: task._id,
              projectId: data.project._id,
              type,
              payload,
            });
          },
          requestApproval: async (kind, summary, payload, requestedByAgentId) => {
            return await client.mutation(api.approvals.request as any, {
              taskId: task._id,
              projectId: data.project._id,
              kind,
              summary,
              payload,
              requestedByAgentId,
            }) as Promise<string>;
          },
          waitApproval: async (approvalId) => {
            const a: any = await client.query(api.approvals.getById as any, { approvalId });
            return { status: a?.status ?? "pending" };
          },
          saveFileChange: async (fc) => {
            return await client.mutation(api.fileChanges.create as any, {
              taskId: task._id,
              projectId: data.project._id,
              filePath: fc.filePath,
              changeType: fc.changeType,
              oldContent: fc.oldContent,
              newContent: fc.newContent,
              diff: fc.diff,
            }) as Promise<string>;
          },
          updateTaskStatus: async (status) => {
            await client.mutation(api.tasks.updateStatus, { taskId: task._id, status: status as any });
          },
          setAgentStatus: async (agentId, status) => {
            await client.mutation(api.agents.updateStatus, { agentId: agentId as any, status: status as any });
          },
        });
      }
    } catch (err) {
      console.error("[worker] error", err);
      if (activeTaskId) {
        const message = err instanceof Error ? err.message : "Worker failed to process task";
        try {
          if (activeAgentId) {
            await client.mutation(api.agents.updateStatus, {
              agentId: activeAgentId as any,
              status: "idle",
            });
          }
          await client.mutation(api.tasks.updateStatus, {
            taskId: activeTaskId as any,
            status: "failed",
          });
          const taskData = await client.action(api.tasks.getForWorker as any, {
            taskId: activeTaskId,
            workerToken: process.env.CONVEX_SERVICE_TOKEN!,
          });
          if (taskData?.project) {
            await client.mutation(api.taskEvents.log as any, {
              taskId: activeTaskId,
              projectId: taskData.project._id,
              type: "task.error",
              payload: { message },
            });
          }
        } catch (cleanupError) {
          console.error("[worker] failed to mark task as failed", cleanupError);
        }
      }
    }
    await sleep(POLL_MS);
  }
}

function isGreeting(command: string): boolean {
  return /^(hello|hi|hey|halo|hai)[!.?,\s]*$/i.test(command.trim());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
