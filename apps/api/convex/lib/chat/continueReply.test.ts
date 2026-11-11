import { describe, expect, it } from "vitest";
import {
  buildContinueMessages,
  buildContinueSystem,
  chatFailureText,
  continueInstruction,
  historyBefore,
  interruptedCutOff,
  isContinueRequest,
  joinContinuation,
  keptPartial,
} from "./continueReply";
import { ChatStreamError, idleStopMessage } from "./streamLimits";

describe("isContinueRequest", () => {
  it("accepts bare continuations in English and Indonesian", () => {
    for (const text of ["continue", "Continue", "continue.", "go on", "lanjut", "Lanjutkan!", "terusin", "lanjut dong", "please continue", "keep going"]) {
      expect(isContinueRequest(text), text).toBe(true);
    }
  });

  it("rejects messages that carry a new request", () => {
    for (const text of ["continue with the backend task", "lanjutkan bikin API login", "can you continue the kanban section and add tests", "", "ok"]) {
      expect(isContinueRequest(text), text).toBe(false);
    }
  });
});

describe("continue prompt", () => {
  const partial = "Priority colors: Low = #6B7280, Medium = --warning. Each is always";

  it("sends the partial reply as the last assistant turn, then the continue instruction", () => {
    const prior = [{ role: "user", content: "Design a task management app" }];
    const msgs = buildContinueMessages(prior, partial);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1].content).toBe(partial);
    expect(msgs[2].content).toBe(continueInstruction(partial));
    expect(msgs[2].content).toContain("from exactly where it stopped");
    expect(msgs[2].content).toContain("Do not repeat");
    expect(msgs[2].content).toContain("Each is always");
  });

  it("quotes only the tail of a long partial and keeps the list starting with a user turn", () => {
    const long = `${"x".repeat(5000)}END`;
    expect(continueInstruction(long)).toContain("…");
    expect(continueInstruction(long).length).toBeLessThan(800);
    expect(buildContinueMessages([], long)[0].role).toBe("user");
    expect(buildContinueMessages([{ role: "assistant", content: "old" }], long)[0].role).toBe("user");
  });

  it("puts the agent persona and the finish-only rule in the system prompt", () => {
    const system = buildContinueSystem({ name: "Designer", role: "designer", systemPrompt: "Be precise." }, "Task Management");
    expect(system).toContain("You are Designer, the designer on the project \"Task Management\".");
    expect(system).toContain("Be precise.");
    expect(system).toContain("Write only the missing rest");
  });

  it("takes the history before the cut reply", () => {
    const history = [
      { authorType: "user", content: "a", messageId: "m1" },
      { authorType: "agent", content: "cut", messageId: "m2" },
      { authorType: "user", content: "continue", messageId: "m3" },
    ];
    expect(historyBefore(history, "m2").map((r) => r.messageId)).toEqual(["m1"]);
    expect(historyBefore(history, "gone")).toEqual([]);
  });
});

describe("joinContinuation", () => {
  it("appends the new text to the cut reply", () => {
    expect(joinContinuation("Each is always", " shown with an icon.")).toBe("Each is always shown with an icon.");
  });

  it("trims a repeated tail", () => {
    expect(joinContinuation("Priority colors: Each is always", "Each is always shown with an icon.")).toBe(
      "Priority colors: Each is always shown with an icon."
    );
    expect(joinContinuation("| Kanban | deferred because", " deferred because drag and drop needs work |")).toBe(
      "| Kanban | deferred because drag and drop needs work |"
    );
  });

  it("does not trim a short coincidental overlap", () => {
    expect(joinContinuation("the end", "end of it")).toBe("the endend of it");
  });
});

describe("partial persistence helpers", () => {
  it("keeps a cut stream's text through the reply's cleaner, with the stop reason", () => {
    const error = new ChatStreamError("idle", idleStopMessage(180_000), { content: "  Kanban  ", reasoning: "thinking" });
    expect(keptPartial(error, (t) => t.trim())).toEqual({ content: "Kanban", reasoning: "thinking" });
    expect(interruptedCutOff(error)).toEqual({ kind: "interrupted", reason: "Reply stopped: the model went silent for 180s" });
  });

  it("keeps nothing when no visible text arrived", () => {
    const error = new ChatStreamError("idle", idleStopMessage(180_000), { content: '{"tool":"read_file"', reasoning: "" });
    expect(keptPartial(error, () => "")).toBeNull();
    expect(keptPartial(new Error("401"), (t) => t)).toBeNull();
  });

  it("says what happened when a reply stopped before any text", () => {
    expect(chatFailureText(new ChatStreamError("idle", idleStopMessage(120_000)))).toBe(
      "Reply stopped: the model went silent for 120s, before any text arrived."
    );
    expect(chatFailureText(new Error("LLM API 401"))).toBe("I couldn't reply (LLM API 401). Check global LLM settings.");
  });
});
