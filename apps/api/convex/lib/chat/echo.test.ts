import { describe, expect, test } from "vitest";
import { streamEchoSafe, stripLeadingEcho, type EchoContext } from "./echo";
import { isHandoffLine } from "./dispatch";

const EN_LINE = "Handing this to @Frontend for the frontend side.";
const ID_LINE = "Saya serahkan ke @QA untuk pengecekan tes ini.";

const frontend: EchoContext = {
  selfNames: ["Frontend", "frontend"],
  speakerNames: ["CTO", "cto", "QA", "qa", "Backend", "backend", "User", "You"],
  priorMessages: [EN_LINE, "can you ask frontend, what is html"],
};
const qa: EchoContext = {
  selfNames: ["QA", "qa"],
  speakerNames: ["CTO", "cto", "Frontend", "frontend", "User"],
  priorMessages: [ID_LINE, "gimana cakupan tes untuk schema kita sekarang?"],
};

describe("stripLeadingEcho", () => {
  test("live bug: the CTO's handoff line copied before the answer is removed", () => {
    expect(stripLeadingEcho(`CTO: ${EN_LINE}\n\nHTML is the markup language of the web.`, frontend)).toBe(
      "HTML is the markup language of the web."
    );
    // Same line, answer on the same line.
    expect(stripLeadingEcho(`CTO: ${EN_LINE} HTML is the markup language.`, frontend)).toBe("HTML is the markup language.");
  });

  test("Indonesian handoff line and a role label", () => {
    expect(stripLeadingEcho(`cto: ${ID_LINE}\nCakupan tes schema masih tipis.`, qa)).toBe("Cakupan tes schema masih tipis.");
  });

  test("markdown and @ around the label", () => {
    expect(stripLeadingEcho(`**CTO:** ${EN_LINE}\nHTML is markup.`, frontend)).toBe("HTML is markup.");
    expect(stripLeadingEcho(`@CTO: ${EN_LINE}\nHTML is markup.`, frontend)).toBe("HTML is markup.");
  });

  test("the user's question copied under User:", () => {
    expect(stripLeadingEcho("User: can you ask frontend, what is html\nHTML stands for HyperText Markup Language.", frontend)).toBe(
      "HTML stands for HyperText Markup Language."
    );
  });

  test("own name prefix, alone or before an echo", () => {
    expect(stripLeadingEcho("Frontend: HTML is markup.", frontend)).toBe("HTML is markup.");
    expect(stripLeadingEcho("frontend: HTML is markup.", frontend)).toBe("HTML is markup.");
    expect(stripLeadingEcho(`Frontend: CTO: ${EN_LINE}\nHTML is markup.`, frontend)).toBe("HTML is markup.");
    expect(stripLeadingEcho("QA: Cakupan tes masih tipis.", qa)).toBe("Cakupan tes masih tipis.");
  });

  test("no false positives", () => {
    for (const reply of [
      "Note: HTML is not a programming language.",
      "HTML: HyperText Markup Language, the structure of a page.",
      "CTO is right that the frontend owns this.",
      "Users can open the page directly.",
      "QA coverage is thin.",
      "Saya serahkan ke tim lain? Tidak, saya jawab sendiri.",
    ]) {
      expect(stripLeadingEcho(reply, frontend)).toBe(reply);
    }
    // A teammate label followed by new text is not an echo of a prior message.
    expect(stripLeadingEcho("CTO: I think we should ship it.", frontend)).toBe("CTO: I think we should ship it.");
  });

  test("a reply that is only the echo becomes empty", () => {
    expect(stripLeadingEcho(`CTO: ${EN_LINE}`, frontend)).toBe("");
  });
});

describe("streamEchoSafe", () => {
  test("holds the text while it could still be an echo, then shows the cleaned answer", () => {
    expect(streamEchoSafe("CT", frontend)).toBe("");
    expect(streamEchoSafe("CTO:", frontend)).toBe("");
    expect(streamEchoSafe("CTO: Handing this to @Front", frontend)).toBe("");
    expect(streamEchoSafe(`CTO: ${EN_LINE}`, frontend)).toBe("");
    expect(streamEchoSafe(`CTO: ${EN_LINE}\nHTML is`, frontend)).toBe("HTML is");
    expect(streamEchoSafe("Frontend:", frontend)).toBe("");
    expect(streamEchoSafe("Frontend: HTML", frontend)).toBe("HTML");
  });

  test("ordinary replies stream through unchanged", () => {
    expect(streamEchoSafe("HTML is the markup", frontend)).toBe("HTML is the markup");
    expect(streamEchoSafe("Note: HTML", frontend)).toBe("Note: HTML");
    expect(streamEchoSafe("CTO: I think", frontend)).toBe("CTO: I think");
  });
});

describe("isHandoffLine", () => {
  test("matches only the fixed handoff copy", () => {
    expect(isHandoffLine(EN_LINE)).toBe(true);
    expect(isHandoffLine(ID_LINE)).toBe(true);
    expect(isHandoffLine("Handing this to @Reviewer for a code audit of `parseConfig`.")).toBe(true);
    expect(isHandoffLine(`${EN_LINE}\nAlso, HTML is markup.`)).toBe(false);
    expect(isHandoffLine("HTML is markup.")).toBe(false);
  });
});

describe("buildChatMessages drops the CTO's handoff line", () => {
  test("a routed turn's handoff line is not a transcript line for the specialist", async () => {
    const { buildChatMessages } = await import("../prompts/chat");
    const msgs = buildChatMessages(
      [
        { authorType: "user", content: "can you ask frontend, what is html" },
        { authorType: "agent", agentId: "cto", content: EN_LINE },
        { authorType: "agent", agentId: "fe", content: "HTML is markup." },
        { authorType: "user", content: "and css?" },
      ],
      { selfAgentId: "fe", nameOf: (id) => (id === "cto" ? "CTO" : id === "fe" ? "Frontend" : undefined) }
    );
    expect(msgs).toEqual([
      { role: "user", content: "can you ask frontend, what is html" },
      { role: "assistant", content: "HTML is markup." },
      { role: "user", content: "and css?" },
    ]);
  });
});
