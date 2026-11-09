import { describe, expect, test } from "vitest";
import { buildDecisionTray, latestOpenOptionPrompt, nextTrayIndex } from "./decisionTray";

const approval = (over: Record<string, unknown>) => ({
  _id: "a1", _creationTime: 10, kind: "apply_changes", summary: "Apply 3 files", taskId: "t1", ...over,
}) as any;

describe("buildDecisionTray", () => {
  test("orders commands first, then approvals, questions, options; scopes to the chat", () => {
    const items = buildDecisionTray({
      conversationId: "c1",
      approvals: [
        approval({ _id: "a1", _creationTime: 5 }),
        approval({ _id: "a2", _creationTime: 20, kind: "run_command", payload: { command: "npm run test", head: "npm run test" }, offerAlways: true }),
        approval({ _id: "a3", _creationTime: 1, conversationId: "other" }),
      ],
      questions: [{ taskId: "t9", title: "T", question: "Pakai Postgres?", options: ["Ya", "Tidak"], at: 3 }],
      optionPrompt: { messageId: "m1", options: [{ id: "A", title: "x" }, { id: "B", title: "y" }], at: 30 },
    });
    expect(items.map((i) => i.key)).toEqual(["approval:a2", "approval:a1", "question:t9", "options:m1"]);
    const cmd = items[0];
    expect(cmd.code).toBe("npm run test");
    expect(cmd.actions.map((a) => a.id)).toEqual(["allow", "always", "deny"]);
    expect(cmd.composerMode).toBe("deny_with_note");
    expect(items[2].actions[0]).toMatchObject({ id: "answer:0", label: "Ya", primary: true });
  });
  test("never offers Always allow for dangerous or un-offered commands", () => {
    const [danger] = buildDecisionTray({ approvals: [approval({ kind: "run_command", payload: { command: "git push", danger: "Pushes to a remote" }, offerAlways: true })] });
    expect(danger.actions.map((a) => a.id)).toEqual(["allow", "deny"]);
    expect(danger.warning).toBe("Pushes to a remote");
    const [plain] = buildDecisionTray({ approvals: [approval({ kind: "run_command", payload: { command: "npm test" }, offerAlways: false })] });
    expect(plain.actions.map((a) => a.id)).toEqual(["allow", "deny"]);
  });
  test("reject of a file change confirms", () => {
    const [item] = buildDecisionTray({ approvals: [approval({})] });
    expect(item.actions.find((a) => a.id === "reject")?.confirm).toBe(true);
  });
});

describe("pager + option prompt", () => {
  test("nextTrayIndex keeps the same item by key", () => {
    const a = [{ key: "x" }, { key: "y" }] as any;
    expect(nextTrayIndex(a, [{ key: "y" }] as any, 1)).toBe(0);
    expect(nextTrayIndex(a, [{ key: "z" }, { key: "w" }] as any, 1)).toBe(1);
    expect(nextTrayIndex(a, [], 1)).toBe(0);
  });
  test("latestOpenOptionPrompt ignores answered prompts", () => {
    const parse = (c: string) => (c.includes("[options]") ? { text: "Mau yang mana?", options: [{ id: "A", title: "a" }, { id: "B", title: "b" }] } : { text: c, options: [] });
    const open = [{ _id: "m1", _creationTime: 1, authorType: "agent", content: "[options]" }];
    expect(latestOpenOptionPrompt(open, parse, () => "cto")?.question).toBe("Mau yang mana?");
    const answered = [...open, { _id: "m2", _creationTime: 2, authorType: "user", content: "I choose A" }];
    expect(latestOpenOptionPrompt(answered, parse, () => "cto")).toBeNull();
  });
});
