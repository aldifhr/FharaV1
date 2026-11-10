/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const node = (id: string, type: "start" | "agent" | "approval" | "conditional" | "end", title: string) => ({
  id,
  type,
  title,
  x: 0,
  y: 0,
  ...(type === "agent" ? { role: "cto", prompt: "Do the thing.", retries: 1 } : {}),
});

describe("workflows functions", () => {
  test("create lists update and remove a workflow", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(api.workflows.create, {
      name: "QA gate",
      nodes: [node("start", "start", "User"), node("qa", "agent", "QA")],
      edges: [
        { id: "edge_1", from: "start", to: "qa", condition: "always" },
        { id: "edge_2", from: "qa", to: "qa", condition: "on_failure", label: "QA fails" },
      ],
    });
    expect(created.name).toBe("QA gate");
    expect(created.nodes).toHaveLength(2);
    expect(created.edges).toHaveLength(2);

    const listed = await t.query(api.workflows.list, {});
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(created.id);

    const updated = await t.mutation(api.workflows.update, { id: created.id, patch: { name: "QA gate v2" } });
    expect(updated.name).toBe("QA gate v2");
    expect((await t.query(api.workflows.list, {}))[0].name).toBe("QA gate v2");

    await t.mutation(api.workflows.update, { id: created.id, patch: { nodes: [node("start", "start", "User")] } });
    const afterNodes = await t.query(api.workflows.list, {});
    expect(afterNodes[0].nodes).toHaveLength(1);

    expect(await t.mutation(api.workflows.remove, { id: created.id })).toBe(true);
    expect(await t.query(api.workflows.list, {})).toHaveLength(0);
    expect(await t.mutation(api.workflows.remove, { id: created.id })).toBe(false);
  });

  test("create rejects an invalid node shape", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.workflows.create, { nodes: [{ id: "n1", type: "bogus" as never, title: "Nope", x: 0, y: 0 }], edges: [] })
    ).rejects.toThrow();
  });
});