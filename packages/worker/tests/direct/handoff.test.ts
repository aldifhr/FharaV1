// G14: handoff compaction and selection (packages/worker/src/direct/handoff.ts).
import { describe, expect, it } from "vitest";
import { compact, handoffNote, HANDOFF_BUDGET, historyItems, ITEM_CHARS, resendTexts, selectHistory, type HandoffEvent } from "@/direct/handoff";

const user = (sequence: number, text: string): HandoffEvent => ({ type: "user.message", sequence, payload: { text } });
const reply = (sequence: number, text: string): HandoffEvent => ({ type: "assistant.text", sequence, payload: { itemId: `a${sequence}`, text } });

describe("handoff compaction", () => {
  it("compacts every item to one line of at most ITEM_CHARS", () => {
    const long = "word ".repeat(400);
    const items = historyItems([
      user(1, `first\n\n${long}`),
      { type: "tool.call", sequence: 2, payload: { itemId: "t", title: `npm run ${long}` } },
      { type: "tool.result", sequence: 3, payload: { itemId: "t", ok: true, text: `line\n${long}` } },
      reply(4, long),
      { type: "turn.completed", sequence: 5, payload: { outcome: "failed", error: long } },
    ]);
    expect(items).toHaveLength(4);
    for (const item of items) {
      expect(item.text.length).toBeLessThanOrEqual(ITEM_CHARS);
      expect(item.text).not.toContain("\n");
      expect(item.text.endsWith("…")).toBe(true);
    }
    expect(compact("short  text\n")).toBe("short text");
    expect(compact("x".repeat(ITEM_CHARS))).toHaveLength(ITEM_CHARS);
  });

  it("keeps the command's result next to it, failed ones marked", () => {
    const [call] = historyItems([
      { type: "tool.call", sequence: 1, payload: { itemId: "t", title: "npm test" } },
      { type: "tool.result", sequence: 2, payload: { itemId: "t", ok: false, text: "2 failing\n  at a.ts:3" } },
    ]);
    expect(call.text).toBe("Tool: npm test failed: 2 failing at a.ts:3");
  });

  it("includes file changes, checkpoints and earlier handoffs", () => {
    const lines = historyItems([
      user(1, "fix it"),
      { type: "edit.diff", sequence: 2, payload: { itemId: "e", path: "src/a.ts" } },
      { type: "checkpoint.restored", sequence: 3, payload: { n: 2, undoApply: false } },
      { type: "checkpoint.revert_committed", sequence: 4, payload: { n: 3, undoApply: true } },
      { type: "system.note", sequence: 5, payload: { text: "x", restore: "not_found" } },
      { type: "system.note", sequence: 6, payload: { text: "transient", restore: "transient" } },
    ]).map((i) => i.text);
    expect(lines).toEqual([
      "User: fix it",
      "Edited: src/a.ts",
      "Checkpoint 2 restored",
      "Checkpoint 3 reverted in a new commit (undo last apply)",
      "Handoff: an earlier session could not be resumed; a new one took over here.",
    ]);
  });
});

describe("handoff selection", () => {
  // 200 exchanges of full-size items: far more than the budget holds.
  const big = (n: number) => `${n} ${"x".repeat(400)}`;
  const events: HandoffEvent[] = [];
  for (let i = 0; i < 200; i++) events.push(user(i * 2 + 1, `ask ${big(i)}`), reply(i * 2 + 2, `answer ${big(i)}`));

  it("stays in budget and keeps the original request and the latest turns", () => {
    const { lines, omitted } = selectHistory(historyItems(events));
    expect(lines.join("\n").length).toBeLessThanOrEqual(HANDOFF_BUDGET);
    expect(omitted).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/^User: ask 0 /);
    expect(lines[1]).toBe("[…]");
    expect(lines.at(-2)).toMatch(/^User: ask 199 /);
    expect(lines.at(-1)).toMatch(/^Assistant: answer 199 /);
    // Newest first after the pinned ones: nothing older is kept while a newer item is dropped.
    const kept = lines.slice(2).map((l) => Number(l.split(" ")[2]));
    expect(kept).toEqual([...kept].sort((a, b) => a - b));
    expect(kept[0]).toBeGreaterThan(150);
  });

  it("never puts the new request in the note, and re-sends it whole", () => {
    const request = `do this ${"y".repeat(150_000)}`;
    const all = [...events, user(1000, request)];
    const note = handoffNote(all, 1000);
    expect(note).not.toContain("do this");
    expect(note.length).toBeLessThan(HANDOFF_BUDGET + 1000);
    const resent = resendTexts(all, [1000]);
    expect(resent).toEqual([{ seq: 1000, text: request }]);
    expect(resent[0].text).toHaveLength(request.length);
  });

  it("re-sends each of the turn's messages in order and skips missing ones", () => {
    expect(resendTexts([user(4, "a"), user(5, "b")], [5, 4, 9])).toEqual([
      { seq: 5, text: "b" },
      { seq: 4, text: "a" },
    ]);
  });
});
