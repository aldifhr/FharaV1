import { describe, expect, test } from "vitest";
import { hintRole } from "../routingHint";
import { hintForCommand, resolveTaskAssignees, routedOwners, teamCto } from "./taskAssignees";

const team = [
  { _id: "cto", name: "CTO", role: "cto" },
  { _id: "fe", name: "Frontend", role: "frontend" },
  { _id: "be", name: "Backend", role: "backend" },
  { _id: "qa", name: "QA", role: "qa" },
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
    // Docs are Backend's now that Support is gone.
    const { owners } = routedOwners("ubah tombol di halaman login dan update README docs", team);
    expect(ids(owners)).toEqual(expect.arrayContaining(["fe", "be"]));
  });

  test("design words route to Frontend, which carries the design role", () => {
    expect(ids(routedOwners("pilih palet warna dan tipografi", team).owners)).toEqual(["fe"]);
  });

  test("nothing matches: no owners, no Backend default", () => {
    // "halo" is Backend's now (it carries the old Support topics), so use a
    // question no role owns.
    expect(routedOwners("menurutmu nama produk ini bagus?", team).owners).toEqual([]);
  });
});

describe("resolveTaskAssignees", () => {
  test("an offer assignee gets CTO + owner + QA", () => {
    expect(ids(resolveTaskAssignees({ team, offerAssigneeId: "fe" }))).toEqual(["cto", "fe", "qa"]);
  });

  test("mentions, the offer assignee, the hint role and routed owners are all owners, in that order, once each", () => {
    const pool = resolveTaskAssignees({
      team,
      mentionedIds: ["be"],
      offerAssigneeId: "fe",
      hint: { source: "offer", role: "qa" },
      routed: [team[1], team[2]],
    });
    expect(ids(pool)).toEqual(["cto", "be", "fe", "qa"]);
  });

  test("a retired hint role resolves to its successor instead of being dropped", () => {
    // A task created before the roster shrank still carries role "reviewer".
    expect(ids(resolveTaskAssignees({ team, hint: { source: "command", role: "reviewer" } }))).toEqual(["cto", "qa"]);
  });

  test("a hint role alone narrows the pool", () => {
    expect(ids(resolveTaskAssignees({ team, hint: { source: "command", role: "frontend" } }))).toEqual(["cto", "fe", "qa"]);
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

  test("a team without a CTO still gets QA", () => {
    const noCto = team.filter((a) => a.role !== "cto");
    expect(ids(resolveTaskAssignees({ team: noCto, offerAssigneeId: "be" }))).toEqual(["be", "qa"]);
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
    expect(hintForCommand("menurutmu nama produk ini bagus?", team, { mentioned: [team[0]] })).toEqual({ source: "command" });
  });

  test("routed owners passed in are used as given", () => {
    const hint = hintForCommand("apa saja", team, { routed: { owners: [team[2]], domain: "backend", topic: "README.md" } });
    expect(hint).toMatchObject({ source: "command", role: "backend", domain: "backend", topic: "README.md" });
  });

  test("a legacy role name resolves to its successor, an unknown one is dropped", () => {
    expect(hintRole("designer")).toBe("designer");
    expect(hintRole("support")).toBe("backend");
    expect(hintRole("reviewer")).toBe("qa");
    expect(hintRole("wizard")).toBeUndefined();
  });
});
