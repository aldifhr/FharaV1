import { describe, expect, test } from "vitest";
import { effectiveTeamIds } from "./projectTeam";

const agent = (id: string, role: string, t: number) => ({ _id: id, role, _creationTime: t }) as any;

describe("effectiveTeamIds", () => {
  test("an explicit roster wins", () => {
    expect(effectiveTeamIds(["a2" as any], [agent("a1", "cto", 1), agent("a2", "qa", 2)])).toEqual(["a2"]);
  });
  test("no roster: the oldest agent per fixed role, in seed order, no retired or custom roles", () => {
    const all = [
      agent("qa", "qa", 5),
      agent("cto", "CTO", 2),
      agent("rev2", "reviewer", 9),
      agent("rev", "reviewer", 3),
      agent("lead", "lead", 1),
      agent("custom", "data-scientist", 1),
    ];
    expect(effectiveTeamIds(undefined, all)).toEqual(["cto", "qa", "rev"]);
    expect(effectiveTeamIds([], all)).toEqual(["cto", "qa", "rev"]);
  });
});
