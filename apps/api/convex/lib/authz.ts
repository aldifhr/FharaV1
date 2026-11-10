import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

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
  if (!configured || !token) return false;
  // Timing-safe comparison: hash both sides, then compare the digests with
  // an XOR-accumulating loop whose runtime does not depend on where (or
  // whether) the inputs differ. Hashing first also hides the token length.
  // The Convex runtime does not guarantee Node's crypto.timingSafeEqual,
  // so SHA-256 is implemented locally below.
  const expected = sha256Digest(configured);
  const presented = sha256Digest(token);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected[i] ^ presented[i];
  }
  return diff === 0;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** Self-contained SHA-256 (sync, no Node crypto dependency). */
function sha256Digest(input: string): Uint8Array {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 2 ** 32), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let block = 0; block < paddedLength; block += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = view.getUint32(block + t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + SHA256_K[t] + w[t]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }

  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) {
    out.setUint32(i * 4, h[i], false);
  }
  return digest;
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

/** True when the viewer may see this project (open project, or their own). */
export function canViewProject(
  viewerId: string | null,
  project: Pick<Doc<"projects">, "ownerId"> | null | undefined
): boolean {
  if (!project) return false;
  return !project.ownerId || project.ownerId === viewerId;
}

/**
 * Ids of every project the caller may see: all open (owner-less) projects
 * plus the viewer's own. Global feeds (overview, inbox, search, …) filter
 * their rows through this set so an unauthenticated caller never reads an
 * owned project's data. Bounded: projects are a small table, read through
 * the by_owner index.
 */
export async function visibleProjects(
  ctx: Ctx,
  limit = 1000
): Promise<Doc<"projects">[]> {
  const viewerId = await getViewerId(ctx);
  const open = await ctx.db
    .query("projects")
    .withIndex("by_owner", (q) => q.eq("ownerId", undefined))
    .take(limit);
  if (!viewerId) return open;
  const own = await ctx.db
    .query("projects")
    .withIndex("by_owner", (q) => q.eq("ownerId", viewerId))
    .take(limit);
  return [...open, ...own];
}

export async function visibleProjectIds(ctx: Ctx): Promise<Set<string>> {
  return new Set((await visibleProjects(ctx)).map((p) => p._id as string));
}

/** True once any project carries an owner (i.e. auth is actually in use). */
async function anyOwnedProject(ctx: Ctx): Promise<boolean> {
  const owned = await ctx.db
    .query("projects")
    .withIndex("by_owner", (q) => q.gte("ownerId", ""))
    .first();
  return owned !== null;
}

/**
 * The agent / role registry is global (shared by every project). Writes to
 * it are allowed for a signed-in viewer, or in local single-user mode (no
 * project has an owner yet). An anonymous caller on a deployment that
 * already has owned projects is refused.
 */
export async function assertRegistryWriteAccess(ctx: Ctx): Promise<void> {
  const viewerId = await getViewerId(ctx);
  if (viewerId) return;
  if (await anyOwnedProject(ctx)) {
    throw new Error("Unauthorized: sign in to change the agent registry");
  }
}

export async function assertAgentAccess(
  ctx: Ctx,
  agentId: Id<"agents">
): Promise<Doc<"agents">> {
  const agent = await ctx.db.get(agentId);
  if (!agent) throw new Error("Agent not found");
  await assertRegistryWriteAccess(ctx);
  return agent;
}

/**
 * Personal chat (plan 039): access to one conversation.
 *
 *  - project/team kind, or a personal conversation with a project attached:
 *    assertProjectAccess on that project (owner rule);
 *  - personal: an ownerId must equal the viewer; without one the row is
 *    reachable only in local single-user mode (no owned project yet), the
 *    same rule as the agent registry. Not a privacy boundary until an auth
 *    provider stamps ownerId on every row.
 */
export async function assertConversationAccess(
  ctx: Ctx,
  conversation: Doc<"conversations">
): Promise<{ project: Doc<"projects"> | null }> {
  const kind = conversation.kind ?? "project";
  if (kind === "personal") {
    const viewerId = await getViewerId(ctx);
    if (conversation.ownerId) {
      if (!viewerId || viewerId !== conversation.ownerId) {
        throw new Error("Unauthorized: conversation access denied");
      }
    } else if (!viewerId && (await anyOwnedProject(ctx))) {
      throw new Error("Unauthorized: conversation access denied");
    }
    if (!conversation.projectId) return { project: null };
    return { project: await assertProjectAccess(ctx, conversation.projectId) };
  }
  if (!conversation.projectId) throw new Error("Conversation has no project");
  return { project: await assertProjectAccess(ctx, conversation.projectId) };
}

/** Load a conversation by id and check access; throws when missing. */
export async function getAccessibleConversation(
  ctx: Ctx,
  conversationId: Id<"conversations">
): Promise<{ conversation: Doc<"conversations">; project: Doc<"projects"> | null }> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) throw new Error("Conversation not found");
  const { project } = await assertConversationAccess(ctx, conversation);
  return { conversation, project };
}

/**
 * Access to one message: through its project when it has one, else through
 * its conversation (a personal chat message carries no projectId, plan
 * 039 D1). A message with neither is refused.
 */
export async function assertMessageAccess(
  ctx: Ctx,
  message: Doc<"messages">
): Promise<{ project: Doc<"projects"> | null; conversation: Doc<"conversations"> | null }> {
  if (message.projectId) {
    const project = await assertProjectAccess(ctx, message.projectId);
    const conversation = message.conversationId ? await ctx.db.get(message.conversationId) : null;
    return { project, conversation };
  }
  if (!message.conversationId) throw new Error("Message not found");
  return getAccessibleConversation(ctx, message.conversationId);
}
