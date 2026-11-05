import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

type Ctx = QueryCtx | MutationCtx;

/**
 * Incremental authorization.
 *
 * This app has not been wired to an auth provider yet. To avoid breaking the
 * single-user local mode we only enforce ownership when an identity is present
 * or the document explicitly carries an ownerId. Once a provider is added, all
 * projects created through `projects.create` will carry ownerId and enforcement
 * becomes automatic.
 */
export async function getViewerId(ctx: Ctx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  return identity?.subject ?? null;
}

export function isServiceTokenValid(token: string | undefined): boolean {
  const configured = process.env.CONVEX_SERVICE_TOKEN;
  return Boolean(configured) && token === configured;
}

export function assertServiceToken(token: string | undefined): void {
  if (!isServiceTokenValid(token)) {
    throw new Error("Worker authentication required");
  }
}

export async function assertProjectAccess(
  ctx: Ctx,
  projectId: Id<"projects">
): Promise<Doc<"projects">> {
  const project = await ctx.db.get(projectId);
  if (!project) throw new Error("Project not found");
  const viewerId = await getViewerId(ctx);
  if (project.ownerId) {
    if (!viewerId || viewerId !== project.ownerId) {
      throw new Error("Unauthorized: project access denied");
    }
  }
  return project;
}

export async function assertTaskAccess(
  ctx: Ctx,
  taskId: Id<"tasks">
): Promise<Doc<"tasks">> {
  const task = await ctx.db.get(taskId);
  if (!task) throw new Error("Task not found");
  await assertProjectAccess(ctx, task.projectId);
  return task;
}

/**
 * Read-side variant for queries that may outlive a deleted task. Returns null
 * instead of throwing when the task no longer exists, while still enforcing
 * ownership when it does.
 */
export async function getVisibleTask(
  ctx: Ctx,
  taskId: Id<"tasks">
): Promise<Doc<"tasks"> | null> {
  const task = await ctx.db.get(taskId);
  if (!task) return null;
  await assertProjectAccess(ctx, task.projectId);
  return task;
}

export async function assertAgentAccess(
  ctx: Ctx,
  agentId: Id<"agents">
): Promise<Doc<"agents">> {
  const agent = await ctx.db.get(agentId);
  if (!agent) throw new Error("Agent not found");
  return agent;
}
