import { describe, expect, test } from "vitest";
import { hintForCommand, resolveTaskAssignees, routedOwners, teamCto } from "./taskAssignees";

const team = [
  { _id: "cto", name: "CTO", role: "cto" },
  { _id: "fe", name: "Frontend", role: "frontend" },
  { _id: "be", name: "Backend", role: "backend" },
  { _id: "rv", name: "Reviewer", role: "reviewer" },
  { _id: "qa", name: "QA", role: "qa" },
  { _id: "doc", name: "Support", role: "support" },
];
const ids = (agents: { _id: string }[]) => agents.map((a) => a._id);

describe("teamCto", () => {
  test("the CTO (or an architect), else null", () => {
    expect(teamCto(team)?._id).toBe("cto");
    expect(teamCto([{ _id: "a", name: "Arch", role: "Architect" }])?._id).toBe("a");
    expect(teamCto(team.filter((a) => a.role !== "cto"))).toBeNull();
  });
});

describe("routedOwners", () => {
  test("a frontend request is owned by Frontend; never the CTO", () => {
    const { owners } = routedOwners("buatkan halaman login dengan tombol dan form", team);
    expect(ids(owners)).toContain("fe");
    expect(ids(owners)).not.toContain("cto");
  });

  test("a two-domain request keeps both owners", () => {
    const { owners } = routedOwners("ubah tombol di halaman login dan update README docs", team);
    expect(ids(owners)).toEqual(expect.arrayContaining(["fe", "doc"]));
  });

  test("nothing matches: no owners, no Backend default", () => {
    const noSupport = team.filter((a) => a.role !== "support");
    expect(routedOwners("halo semuanya", noSupport).owners).toEqual([]);
  });
});

describe("resolveTaskAssignees", () => {
  test("an offer assignee gets CTO + owner + Reviewer + QA", () => {
    expect(ids(resolveTaskAssignees({ team, offerAssigneeId: "fe" }))).toEqual(["cto", "fe", "rv", "qa"]);
  });

  test("mentions, the offer assignee, the hint role and routed owners are all owners, in that order, once each", () => {
    const pool = resolveTaskAssignees({
      team,
      mentionedIds: ["be"],
      offerAssigneeId: "fe",
      hint: { source: "offer", role: "support" },
      routed: [team[1], team[2]],
    });
    expect(ids(pool)).toEqual(["cto", "be", "fe", "doc", "rv", "qa"]);
  });

  test("a hint role alone narrows the pool", () => {
    expect(ids(resolveTaskAssignees({ team, hint: { source: "command", role: "frontend" } }))).toEqual(["cto", "fe", "rv", "qa"]);
  });

  test("no owner, or the CTO as the only owner: no narrowing (whole team)", () => {
    expect(resolveTaskAssignees({ team })).toEqual([]);
    expect(resolveTaskAssignees({ team, mentionedIds: ["cto"] })).toEqual([]);
    expect(resolveTaskAssignees({ team, offerAssigneeId: "ghost" })).toEqual([]);
  });

  test("re-resolving a resolved pool gives the same pool", () => {
    const first = resolveTaskAssignees({ team, offerAssigneeId: "fe" });
    expect(resolveTaskAssignees({ team, mentionedIds: ids(first) })).toEqual(first);
  });

  test("a team without a CTO still gets Reviewer and QA", () => {
    const noCto = team.filter((a) => a.role !== "cto");
    expect(ids(resolveTaskAssignees({ team: noCto, offerAssigneeId: "be" }))).toEqual(["be", "rv", "qa"]);
  });
});

describe("hintForCommand", () => {
  test("a typed command: source command, the routed owner's role, files from the text, not hard", () => {
    const hint = hintForCommand("buatkan halaman login.tsx dengan form", team);
    expect(hint).toMatchObject({ source: "command", role: "frontend", files: ["login.tsx"] });
    expect(hint.hard).toBeUndefined();
  });

  test("an @mention is binding and wins over the routed owner; a mentioned CTO is not an owner", () => {
    expect(hintForCommand("buatkan halaman login", team, { mentioned: [team[2]] })).toMatchObject({ source: "mention", role: "backend", hard: true });
    const noSupport = team.filter((a) => a.role !== "support");
    expect(hintForCommand("halo", noSupport, { mentioned: [team[0]] })).toEqual({ source: "command" });
  });

  test("routed owners passed in are used as given", () => {
    const hint = hintForCommand("apa saja", team, { routed: { owners: [team[5]], domain: "support", topic: "README.md" } });
    expect(hint).toMatchObject({ source: "command", role: "support", domain: "support", topic: "README.md" });
  });
});
