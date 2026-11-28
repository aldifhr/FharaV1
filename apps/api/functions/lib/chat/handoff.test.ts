import { describe, expect, test } from "vitest";
import { echoedRequest, MAX_HANDOFFS, parseStructuredReply, resolveHandoffTargets, unmatchedHandoffRoles } from "./handoff";

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

  test("a retired alias or a role title maps to its roster role instead of dropping the reply", () => {
    // Before: "support" and "Backend Developer" were not ROLE_KEYS, so the whole
    // reply — message included — was thrown away and the CTO looked like it
    // answered alone. The registry resolver now maps them the way the rest of
    // the system already does.
    const reply = parseStructuredReply(JSON.stringify({
      message: "Split the work.",
      handoff: [
        { role: "support", instruction: "Write the docs." },
        { role: "Backend Developer", instruction: "Update the schema." },
      ],
    }));
    expect(reply?.message).toBe("Split the work.");
    expect(reply?.handoff.map((entry) => entry.role)).toEqual(["backend"]);
  });

  test("a role the registry does not know invalidates the whole reply", () => {
    expect(parseStructuredReply(JSON.stringify({
      message: "ok",
      handoff: [{ role: "wizard", instruction: "unknown role" }],
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

  test("a long user request copied verbatim is an echoed handoff", () => {
    const request = "Di D:\\CODE\\demo-app, jalankan typecheck, lint, build, lalu dev server dan verifikasi halaman.";
    expect(echoedRequest(request, request)).toBe(true);
    expect(echoedRequest("  di D:\\CODE\\demo-app,  jalankan typecheck, lint, build, lalu dev server dan verifikasi halaman. ", request)).toBe(true);
  });

  test("a short request and a condensed order are not echoes", () => {
    expect(echoedRequest("check the tests", "check the tests")).toBe(false);
    expect(echoedRequest("Run the build and report any failures.", "Di D:\\CODE\\demo-app, jalankan typecheck, lint, build, lalu dev server.")).toBe(false);
  });
});
