import { describe, expect, test } from "vitest";
import { MAX_HANDOFFS, parseStructuredReply, resolveHandoffTargets, unmatchedHandoffRoles } from "./handoff";

const team = [
  { _id: "cto", role: "cto" },
  { _id: "be", role: "Backend Developer" },
  { _id: "fe", role: "frontend" },
  { _id: "qa", role: "qa" },
];

describe("structured CTO/Lead handoff", () => {
  test("keeps every role in the reply", () => {
    const reply = parseStructuredReply(JSON.stringify({
      message: "I split the work.",
      handoff: [
        { role: "backend", instruction: "Update the schema." },
        { role: "qa", instruction: "Check the tests." },
      ],
    }));
    expect(reply).not.toBeNull();
    expect(reply!.handoff.map((entry) => entry.role)).toEqual(["backend", "qa"]);
    expect(resolveHandoffTargets(reply!.handoff, team, "cto").map((t) => t.agent._id)).toEqual(["be", "qa"]);
  });

  test("a role outside ROLE_KEYS invalidates the whole reply", () => {
    expect(parseStructuredReply(JSON.stringify({
      message: "ok",
      handoff: [{ role: "support", instruction: "old role" }],
    }))).toBeNull();
    expect(parseStructuredReply(JSON.stringify({
      message: "ok",
      handoff: [{ role: "backend", instruction: "" }],
    }))).toBeNull();
    expect(parseStructuredReply("{not json")).toBeNull();
  });

  test("too many handoffs are rejected", () => {
    const handoff = Array.from({ length: MAX_HANDOFFS + 1 }, () => ({ role: "qa", instruction: "check" }));
    expect(parseStructuredReply(JSON.stringify({ message: "ok", handoff }))).toBeNull();
  });

  test("the message is never rewritten by the parser", () => {
    const message = "Konflik with Backend sudah saya catat. Task sudah dibuat.";
    expect(parseStructuredReply(JSON.stringify({ message, handoff: [] }))?.message).toBe(message);
  });

  test("unmatched roles are reported instead of silently dropped", () => {
    expect(unmatchedHandoffRoles([{ role: "designer", instruction: "spec" }], team)).toEqual(["designer"]);
  });
});
