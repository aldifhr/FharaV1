import { describe, expect, test } from "vitest";
import { hintRole } from "../routingHint";
import { hintForCommand, resolveTaskAssignees, routedOwners, teamCto } from "./taskAssignees";
import type { RoutingClassification } from "./routingClassification";

const team = [
  { _id: "cto", name: "CTO", role: "cto" },
  { _id: "fe", name: "Frontend", role: "frontend" },
  { _id: "be", name: "Backend", role: "backend" },
  { _id: "qa", name: "QA", role: "qa" },
];
const ids = (agents: { _id: string }[]) => agents.map((a) => a._id);
const routing = (role: string | null, kind: RoutingClassification["kind"] = "implementation", confidence = 0.9): RoutingClassification => ({
  role: role as RoutingClassification["role"],
  kind,
  files: [],
  confidence,
});

describe("teamCto", () => {
  test("registry CTO aliases, else null", () => {
    expect(teamCto(team)?._id).toBe("cto");
    expect(teamCto([{ _id: "a", name: "Arch", role: "Architect" }])?._id).toBe("a");
    expect(teamCto([{ _id: "o", name: "Orchestrator", role: "orchestrator" }])?._id).toBe("o");
    expect(teamCto(team.filter((a) => a.role !== "cto"))).toBeNull();
  });
});

describe("routedOwners (structured only)", () => {
  test("a validated role owns the task; the CTO never does", () => {
    expect(ids(routedOwners(routing("frontend"), team).owners)).toEqual(["fe"]);
    expect(ids(routedOwners(routing("cto"), team).owners)).toEqual([]);
  });

  test("designer and qa roles resolve to their teams", () => {
    const designTeam = [...team, { _id: "des", name: "Designer", role: "designer" }];
    expect(ids(routedOwners(routing("designer", "design"), designTeam).owners)).toEqual(["des"]);
    expect(ids(routedOwners(routing("qa", "verification"), team).owners)).toEqual(["qa"]);
  });

  test("files and kind ride on the hint", () => {
    expect(routedOwners({ ...routing("frontend"), files: ["src/status.tsx"] }, team)).toMatchObject({
      domain: "implementation",
      topic: "src/status.tsx",
    });
  });

  test("no role: no owner, no Backend default, even when the text names Backend", () => {
    expect(routedOwners(routing(null), team).owners).toEqual([]);
    expect(routedOwners(undefined, team).owners).toEqual([]);
  });
});

describe("resolveTaskAssignees", () => {
  test("an offer assignee gets CTO + owner + QA", () => {
    expect(ids(resolveTaskAssignees({ team, offerAssigneeId: "fe" }))).toEqual(["cto", "fe", "qa"]);
  });

  test("mentions, offer assignee, hint role and routed owners are all owners, in order, once each", () => {
    const pool = resolveTaskAssignees({
      team,
      mentionedIds: ["be"],
      offerAssigneeId: "fe",
      hint: { source: "offer", role: "qa" },
      routed: [team[1], team[2]],
    });
    expect(ids(pool)).toEqual(["cto", "be", "fe", "qa"]);
  });

  test("a retired hint role resolves to its successor", () => {
    expect(ids(resolveTaskAssignees({ team, hint: { source: "command", role: "reviewer" } }))).toEqual(["cto", "qa"]);
  });

  test("no owner, or the CTO as the only owner: no narrowing", () => {
    expect(resolveTaskAssignees({ team })).toEqual([]);
    expect(resolveTaskAssignees({ team, mentionedIds: ["cto"] })).toEqual([]);
    expect(resolveTaskAssignees({ team, offerAssigneeId: "ghost" })).toEqual([]);
  });

  test("re-resolving a resolved pool gives the same pool", () => {
    const first = resolveTaskAssignees({ team, offerAssigneeId: "fe" });
    expect(resolveTaskAssignees({ team, mentionedIds: ids(first) })).toEqual(first);
  });

  test("a team without a CTO still gets QA", () => {
    const noCto = team.filter((a) => a.role !== "cto");
    expect(ids(resolveTaskAssignees({ team: noCto, offerAssigneeId: "be" }))).toEqual(["be", "qa"]);
  });
});

describe("hintForCommand", () => {
  test("files come from the user's text; role only from explicit routed data", () => {
    expect(hintForCommand("buatkan halaman login.tsx dengan form", team)).toMatchObject({
      source: "command",
      files: ["login.tsx"],
    });
    expect(hintForCommand("buatkan halaman login.tsx dengan form", team).role).toBeUndefined();
  });

  test("an @mention is binding; a mentioned CTO is not an owner", () => {
    expect(hintForCommand("buatkan halaman login", team, { mentioned: [team[2]] })).toMatchObject({ source: "mention", role: "backend", hard: true });
    expect(hintForCommand("menurutmu nama produk ini bagus?", team, { mentioned: [team[0]] })).toEqual({ source: "command" });
  });

  test("routed owners passed in are used as given", () => {
    const hint = hintForCommand("apa saja", team, { routed: { owners: [team[2]], domain: "backend", topic: "README.md" } });
    expect(hint).toMatchObject({ source: "command", role: "backend", domain: "backend", topic: "README.md" });
  });

  test("legacy role names resolve to successors, unknown names drop", () => {
    expect(hintRole("designer")).toBe("designer");
    expect(hintRole("support")).toBe("backend");
    expect(hintRole("reviewer")).toBe("qa");
    expect(hintRole("wizard")).toBeUndefined();
  });
});
