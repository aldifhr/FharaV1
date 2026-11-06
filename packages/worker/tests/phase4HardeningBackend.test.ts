import { beforeAll, describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The backend handlers are loaded with dynamic imports by file path
 * (in beforeAll below), not with static imports: the worker package's
 * tsconfig program must not absorb the whole Convex module graph
 * (its lib set lacks the DOM WebCrypto types the API workspace's own
 * tsconfig provides, which would surface as phantom errors in
 * unrelated API files). Vitest resolves and transforms the modules
 * exactly the same at runtime.
 */
let completeTask: unknown;
let recoverStale: unknown;
let requestApproval: unknown;
let setTaskStatus: unknown;
let updateSubtask: unknown;
let upsertDynamicSubtasks: unknown;
let cancelTask: unknown;
let retryTask: unknown;

beforeAll(async () => {
  const convexDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../apps/api/convex"
  );
  const orchestration = (await import(
    path.join(convexDir, "orchestration.ts")
  )) as Record<string, unknown>;
  const tasks = (await import(
    path.join(convexDir, "tasks.ts")
  )) as Record<string, unknown>;
  completeTask = orchestration.completeTask;
  recoverStale = orchestration.recoverStale;
  requestApproval = orchestration.requestApproval;
  setTaskStatus = orchestration.setTaskStatus;
  updateSubtask = orchestration.updateSubtask;
  upsertDynamicSubtasks = orchestration.upsertDynamicSubtasks;
  cancelTask = tasks.cancel;
  retryTask = tasks.retry;
});

/**
 * Phase 4 hardening — BACKEND guards, tested at the handler level.
 *
 * convex-test is not available in this workspace, so the REAL mutation
 * handlers are invoked directly (their `_handler` functions) against
 * an in-memory FakeDb that implements the subset of the Convex data
 * API these handlers use (insert/get/patch/delete, indexed queries
 * with eq/lt/gt predicates, order/take/unique/collect), including
 * Convex's "patch with undefined deletes the field" rule.
 *
 * Convex executes mutations serially (optimistic concurrency with
 * retries at the platform level), so concurrent handler invocations
 * in these tests are funneled through `serialized(...)` — a promise
 * chain that reproduces that execution order — while still being
 * ISSUED concurrently via Promise.all. The runner-side restart and
 * race coverage lives in phase4HardeningRecovery.test.ts; what is
 * proven here is the database-layer contract itself: terminal task
 * statuses are absorbing, dynamic-subtask upserts are idempotent and
 * monotonic, and manual retry resets recoveryCount while automatic
 * stale recovery increments it.
 */

type Row = Record<string, unknown> & { _id: string; _creationTime: number };

type Predicate = {
  field: string;
  op: "eq" | "lt" | "gt" | "lte" | "gte";
  value: unknown;
};

class PredicateBuilder {
  readonly predicates: Predicate[] = [];
  eq(field: string, value: unknown): this {
    this.predicates.push({ field, op: "eq", value });
    return this;
  }
  lt(field: string, value: unknown): this {
    this.predicates.push({ field, op: "lt", value });
    return this;
  }
  gt(field: string, value: unknown): this {
    this.predicates.push({ field, op: "gt", value });
    return this;
  }
  lte(field: string, value: unknown): this {
    this.predicates.push({ field, op: "lte", value });
    return this;
  }
  gte(field: string, value: unknown): this {
    this.predicates.push({ field, op: "gte", value });
    return this;
  }
  and(...others: PredicateBuilder[]): this {
    for (const other of others) this.predicates.push(...other.predicates);
    return this;
  }
  or(...others: PredicateBuilder[]): this {
    // None of the handlers under test use or(); treat as and() so an
    // accidental use fails loudly via wrong results, never silently.
    return this.and(...others);
  }
  field(name: string): string {
    return name;
  }
}

function matches(row: Row, predicate: Predicate): boolean {
  const actual = row[predicate.field] as number;
  const expected = predicate.value as number;
  switch (predicate.op) {
    case "eq":
      return row[predicate.field] === predicate.value;
    case "lt":
      return actual < expected;
    case "gt":
      return actual > expected;
    case "lte":
      return actual <= expected;
    case "gte":
      return actual >= expected;
  }
}

class FakeQuery {
  private predicates: Predicate[] = [];
  private descending = false;
  constructor(
    private readonly db: FakeDb,
    private readonly table: string
  ) {}
  withIndex(
    _name: string,
    build: (q: PredicateBuilder) => unknown
  ): this {
    const builder = new PredicateBuilder();
    build(builder);
    this.predicates = builder.predicates;
    return this;
  }
  order(direction: "asc" | "desc"): this {
    this.descending = direction === "desc";
    return this;
  }
  private rows(): Row[] {
    const filtered = this.db
      .rowsOf(this.table)
      .filter((row) => this.predicates.every((p) => matches(row, p)));
    filtered.sort((a, b) => a._creationTime - b._creationTime);
    if (this.descending) filtered.reverse();
    // Convex returns snapshot copies, never live references: a row a
    // handler fetched must not change when a later patch lands.
    return filtered.map((row) => ({ ...row }));
  }
  async collect(): Promise<Row[]> {
    return this.rows();
  }
  async take(n: number): Promise<Row[]> {
    return this.rows().slice(0, n);
  }
  async unique(): Promise<Row | null> {
    const rows = this.rows();
    return rows.length === 1 ? rows[0] : null;
  }
  async first(): Promise<Row | null> {
    return this.rows()[0] ?? null;
  }
}

class FakeDb {
  private readonly tables = new Map<string, Map<string, Row>>();
  private sequence = 0;

  rowsOf(table: string): Row[] {
    return [...(this.tables.get(table)?.values() ?? [])];
  }
  private tableMap(table: string): Map<string, Row> {
    let map = this.tables.get(table);
    if (!map) {
      map = new Map();
      this.tables.set(table, map);
    }
    return map;
  }
  async insert(
    table: string,
    doc: Record<string, unknown>
  ): Promise<string> {
    this.sequence += 1;
    const id = `${table}:${this.sequence}`;
    this.tableMap(table).set(id, {
      ...doc,
      _id: id,
      _creationTime: this.sequence,
    });
    return id;
  }
  async get(id: string): Promise<Row | null> {
    const table = id.split(":")[0];
    const row = this.tables.get(table)?.get(id);
    return row ? { ...row } : null;
  }
  async patch(
    id: string,
    fields: Record<string, unknown>
  ): Promise<void> {
    const table = id.split(":")[0];
    const row = this.tables.get(table)?.get(id);
    if (!row) throw new Error(`patch: no such document ${id}`);
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) delete row[key];
      else row[key] = value;
    }
  }
  async delete(id: string): Promise<void> {
    const table = id.split(":")[0];
    this.tables.get(table)?.delete(id);
  }
  query(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }
}

interface FakeCtx {
  db: FakeDb;
  auth: { getUserIdentity: () => Promise<null> };
}

function makeCtx(db: FakeDb): FakeCtx {
  return { db, auth: { getUserIdentity: async () => null } };
}

type AnyHandler = (
  ctx: FakeCtx,
  args: Record<string, unknown>
) => Promise<unknown>;

function callHandler(
  fn: unknown,
  ctx: FakeCtx,
  args: Record<string, unknown>
): Promise<unknown> {
  const handler = (fn as { _handler: AnyHandler })._handler;
  return handler(ctx, args);
}

/**
 * Convex runs mutations one at a time; this chain reproduces that
 * serialization for calls the test issues concurrently.
 */
let mutationChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const result = mutationChain.then(fn, fn);
  mutationChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function seedTask(
  db: FakeDb,
  fields: Record<string, unknown>
): Promise<{ projectId: string; taskId: string }> {
  const projectId = await db.insert("projects", {
    name: "Project",
    slug: `p-${Math.random()}`,
    workspacePath: "workspace",
    createdAt: 1,
    updatedAt: 1,
  });
  const taskId = await db.insert("tasks", {
    projectId,
    title: "Task",
    command: "do the thing",
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  });
  return { projectId, taskId };
}

interface CompleteResult {
  applied: boolean;
  reason?: string;
  status: string;
}

const PLAN_SUBTASK = {
  key: "implement",
  title: "Implement",
  description: "Build it",
  kind: "code_change",
  capability: "frontend-development",
  dependencies: [] as string[],
  order: 0,
};

function planPayload(subtasks: unknown[]): Record<string, unknown> {
  return {
    version: 1,
    goal: "goal",
    strategy: "single",
    requiresApproval: false,
    maxConcurrency: 2,
    subtasks,
  };
}

describe("backend terminal guards (Phase 4 hardening)", () => {
  it("a late completion after user cancellation does not change the task (addendum test)", async () => {
    const db = new FakeDb();
    const ctx = makeCtx(db);
    const { taskId } = await seedTask(db, { status: "running" });

    // The user cancels through the REAL tasks.cancel mutation.
    const cancelled = await callHandler(cancelTask, ctx, { taskId });
    expect(cancelled).toBe(true);
    const afterCancel = await db.get(taskId);
    expect(afterCancel?.status).toBe("failed");
    expect(afterCancel?.errorMessage).toBe("Cancelled by user");
    const cancelCompletedAt = afterCancel?.completedAt;

    // A worker that finishes late tries to mark the task done: the
    // mutation REFUSES with a value (no throw) and nothing changes.
    const late = (await callHandler(completeTask, ctx, {
      taskId,
      status: "done",
    })) as CompleteResult;
    expect(late.applied).toBe(false);
    expect(late.reason).toBe("task_already_terminal");
    expect(late.status).toBe("failed");

    // A late failure with a different message is refused too: the
    // first terminal outcome (the cancellation) wins.
    const lateFail = (await callHandler(completeTask, ctx, {
      taskId,
      status: "failed",
      errorMessage: "some late worker error",
    })) as CompleteResult;
    expect(lateFail.applied).toBe(false);

    const after = await db.get(taskId);
    expect(after?.status).toBe("failed");
    expect(after?.errorMessage).toBe("Cancelled by user");
    expect(after?.completedAt).toBe(cancelCompletedAt);
  });

  it("completeTask still applies to a running task (control)", async () => {
    const db = new FakeDb();
    const ctx = makeCtx(db);
    const { taskId } = await seedTask(db, { status: "running" });
    const result = (await callHandler(completeTask, ctx, {
      taskId,
      status: "done",
    })) as CompleteResult;
    expect(result).toEqual({ applied: true, status: "done" });
    expect((await db.get(taskId))?.status).toBe("done");
  });

  it("two competing completions issued concurrently: exactly one applies", async () => {
    const db = new FakeDb();
    const ctx = makeCtx(db);
    const { taskId } = await seedTask(db, { status: "running" });

    // Issued concurrently; executed serially, as Convex runs
    // mutations. Whichever lands first wins, the other is refused.
    const [first, second] = (await Promise.all([
      serialized(() =>
        callHandler(completeTask, ctx, { taskId, status: "done" })
      ),
      serialized(() =>
        callHandler(completeTask, ctx, {
          taskId,
          status: "failed",
          errorMessage: "loser",
        })
      ),
    ])) as [CompleteResult, CompleteResult];

    expect([first.applied, second.applied].sort()).toEqual([false, true]);
    const winnerStatus = first.applied ? "done" : "failed";
    expect((await db.get(taskId))?.status).toBe(winnerStatus);
    const completionEvents = db
      .rowsOf("taskEvents")
      .filter((e) => e.type === "task.done" || e.type === "task.failed");
    expect(completionEvents).toHaveLength(1);
  });

  it("setTaskStatus cannot resurrect a terminal task", async () => {
    const db = new FakeDb();
    const ctx = makeCtx(db);
    const { taskId } = await seedTask(db, {
      status: "failed",
      errorMessage: "boom",
    });
    const resurrect = await callHandler(setTaskStatus, ctx, {
      taskId,
      status: "running",
    });
    expect(resurrect).toBe(false);
    expect((await db.get(taskId))?.status).toBe("failed");
    // Rewriting the same terminal status stays allowed (idempotent).
    const same = await callHandler(setTaskStatus, ctx, {
      taskId,
      status: "failed",
    });
    expect(same).toBe(true);
  });

  it("requestApproval on a terminal task refuses and does not reopen it", async () => {
    const db = new FakeDb();
    const ctx = makeCtx(db);
    const { projectId, taskId } = await seedTask(db, { status: "failed" });
    await expect(
      callHandler(requestApproval, ctx, {
        taskId,
        projectId,
        kind: "apply_changes",
        summary: "apply?",
      })
    ).rejects.toThrow(/already failed/);
    expect((await db.get(taskId))?.status).toBe("failed");
    expect(db.rowsOf("approvals")).toHaveLength(0);

    // Control: a running task can still request approval.
    const live = await seedTask(db, { status: "running" });
    const approvalId = await callHandler(requestApproval, ctx, {
      taskId: live.taskId,
      projectId: live.projectId,
      kind: "apply_changes",
      summary: "apply?",
    });
    expect(typeof approvalId).toBe("string");
    expect((await db.get(live.taskId))?.status).toBe("needs_approval");
  });
});

describe("dynamic subtask persistence (backend, addendum)", () => {
  it("upsert is idempotent on (taskId, key), merges the plan payload, and never downgrades a completed row", async () => {
    const db = new FakeDb();
    const ctx = makeCtx(db);
    const { projectId, taskId } = await seedTask(db, { status: "running" });
    const planId = await db.insert("plans", {
      taskId,
      projectId,
      version: 2,
      createdBy: "orchestrator",
      payload: planPayload([PLAN_SUBTASK]),
    });
    await db.insert("subtasks", {
      taskId,
      projectId,
      planId,
      ...PLAN_SUBTASK,
      status: "pending",
      attempts: 0,
    });

    const delegateSubtask = {
      key: "delegate_security-audit_1",
      title: "Security audit (delegated)",
      description: "Delegated by the orchestrator",
      kind: "audit",
      capability: "security-audit",
      dependencies: ["implement"],
      order: 1,
      origin: "delegation",
    };
    const upsertArgs = {
      taskId,
      projectId,
      version: 2,
      payload: planPayload([PLAN_SUBTASK, delegateSubtask]),
      subtasks: [delegateSubtask],
    };

    interface UpsertResult {
      inserted: string[];
      existing: string[];
      payloadUpdated: boolean;
    }
    const first = (await callHandler(
      upsertDynamicSubtasks,
      ctx,
      upsertArgs as unknown as Record<string, unknown>
    )) as UpsertResult;
    expect(first).toEqual({
      inserted: ["delegate_security-audit_1"],
      existing: [],
      payloadUpdated: true,
    });

    const rowsOfKey = () =>
      db
        .rowsOf("subtasks")
        .filter((r) => r.key === "delegate_security-audit_1");
    expect(rowsOfKey()).toHaveLength(1);
    expect(rowsOfKey()[0].status).toBe("pending");
    expect(rowsOfKey()[0].origin).toBe("delegation");
    const planAfter = await db.get(planId);
    const payload = planAfter?.payload as { subtasks: { key: string }[] };
    expect(payload.subtasks.map((s) => s.key)).toEqual([
      "implement",
      "delegate_security-audit_1",
    ]);

    // Repeating the same write (a retried action call, a duplicated
    // callback) changes nothing.
    const repeat = (await callHandler(
      upsertDynamicSubtasks,
      ctx,
      upsertArgs as unknown as Record<string, unknown>
    )) as UpsertResult;
    expect(repeat).toEqual({
      inserted: [],
      existing: ["delegate_security-audit_1"],
      payloadUpdated: false,
    });
    expect(rowsOfKey()).toHaveLength(1);

    // Two different dynamic nodes written concurrently both land.
    const fixA = { ...delegateSubtask, key: "fix_a", origin: "fix" };
    const fixB = { ...delegateSubtask, key: "fix_b", origin: "fix" };
    await Promise.all([
      serialized(() =>
        callHandler(upsertDynamicSubtasks, ctx, {
          taskId,
          projectId,
          version: 2,
          payload: planPayload([PLAN_SUBTASK, delegateSubtask, fixA, fixB]),
          subtasks: [fixA],
        })
      ),
      serialized(() =>
        callHandler(upsertDynamicSubtasks, ctx, {
          taskId,
          projectId,
          version: 2,
          payload: planPayload([PLAN_SUBTASK, delegateSubtask, fixA, fixB]),
          subtasks: [fixB],
        })
      ),
    ]);
    const dynamicKeys = db
      .rowsOf("subtasks")
      .map((r) => r.key)
      .sort();
    expect(dynamicKeys).toEqual([
      "delegate_security-audit_1",
      "fix_a",
      "fix_b",
      "implement",
    ]);

    // Monotonicity: the node completes; a late re-upsert and a stale
    // "blocked" write must not downgrade it.
    const delegateRow = rowsOfKey()[0];
    await db.patch(delegateRow._id, { status: "completed" });
    await callHandler(
      upsertDynamicSubtasks,
      ctx,
      upsertArgs as unknown as Record<string, unknown>
    );
    expect(rowsOfKey()[0].status).toBe("completed");
    const updated = await callHandler(updateSubtask, ctx, {
      taskId,
      key: "delegate_security-audit_1",
      status: "blocked",
    });
    expect(updated).toBe(true);
    expect(rowsOfKey()[0].status).toBe("completed");

    // A checkpoint written against a DIFFERENT plan version does not
    // overwrite the stored payload (the row insert is still safe).
    const stale = (await callHandler(upsertDynamicSubtasks, ctx, {
      taskId,
      projectId,
      version: 99,
      payload: planPayload([{ ...PLAN_SUBTASK, key: "ghost" }]),
      subtasks: [{ ...delegateSubtask, key: "ghost" }],
    })) as UpsertResult;
    expect(stale.payloadUpdated).toBe(false);
    const finalPlan = await db.get(planId);
    const finalPayload = finalPlan?.payload as {
      subtasks: { key: string }[];
    };
    expect(
      finalPayload.subtasks.some((s) => s.key === "ghost")
    ).toBe(false);
  });
});

describe("manual retry semantics (mandatory test 11)", () => {
  it("tasks.retry resets recoveryCount to 0 and preserves completed subtasks", async () => {
    const db = new FakeDb();
    const ctx = makeCtx(db);
    const { taskId } = await seedTask(db, {
      status: "failed",
      recoveryCount: 2,
      replanCount: 5,
      errorMessage: "boom",
    });
    await db.insert("subtasks", {
      taskId,
      key: "implement",
      status: "completed",
      output: "finished work",
      attempts: 1,
    });
    await db.insert("subtasks", {
      taskId,
      key: "test",
      status: "failed",
      attempts: 2,
    });

    const result = await callHandler(retryTask, ctx, { taskId });
    expect(result).toBe(true);

    const task = await db.get(taskId);
    expect(task?.status).toBe("queued");
    expect(task?.recoveryCount).toBe(0);
    expect(task?.replanCount).toBe(0);

    const subs = db.rowsOf("subtasks");
    const completed = subs.find((s) => s.key === "implement");
    expect(completed?.status).toBe("completed");
    expect(completed?.output).toBe("finished work");
    const failed = subs.find((s) => s.key === "test");
    expect(failed?.status).toBe("pending");
    expect(failed?.attempts).toBe(0);

    const retriedEvent = db
      .rowsOf("taskEvents")
      .find((e) => e.type === "task.retried");
    expect(
      (retriedEvent?.payload as { previousRecoveryCount: number })
        .previousRecoveryCount
    ).toBe(2);
  });

  it("recoverStale increments recoveryCount (never resets) and fails the task at the bound", async () => {
    const db = new FakeDb();
    const ctx = makeCtx(db);
    const now = 1_000_000;

    // Recoverable: valid stored plan + subtask rows, count 0.
    const a = await seedTask(db, {
      status: "running",
      workerId: "dead-worker",
      leaseExpiresAt: 10,
      recoveryCount: 0,
    });
    await db.insert("plans", {
      taskId: a.taskId,
      projectId: a.projectId,
      version: 1,
      createdBy: "orchestrator",
      payload: planPayload([PLAN_SUBTASK]),
    });
    await db.insert("subtasks", {
      taskId: a.taskId,
      key: "implement",
      status: "running",
    });

    // At the recovery bound: same setup, count already at the max (3).
    const b = await seedTask(db, {
      status: "running",
      workerId: "dead-worker",
      leaseExpiresAt: 10,
      recoveryCount: 3,
    });
    await db.insert("plans", {
      taskId: b.taskId,
      projectId: b.projectId,
      version: 1,
      createdBy: "orchestrator",
      payload: planPayload([PLAN_SUBTASK]),
    });
    await db.insert("subtasks", {
      taskId: b.taskId,
      key: "implement",
      status: "pending",
    });

    await callHandler(recoverStale, ctx, { now });

    const taskA = await db.get(a.taskId);
    expect(taskA?.status).toBe("queued");
    expect(taskA?.recoveryCount).toBe(1);
    const subA = db
      .rowsOf("subtasks")
      .find((s) => s.taskId === a.taskId);
    expect(subA?.status).toBe("pending");

    const taskB = await db.get(b.taskId);
    expect(taskB?.status).toBe("failed");
    expect(taskB?.recoveryCount).toBe(3);
  });
});
