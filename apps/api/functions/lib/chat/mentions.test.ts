import { describe, expect, test } from "vitest";
import { mentionTargets } from "./mentions";

const team = [
  { _id: "cto", name: "Carmen", role: "cto" },
  { _id: "be", name: "Budi", role: "Backend Developer" },
  { _id: "fe", name: "Eir", role: "frontend" },
  { _id: "ops", name: "Dewi", role: "devops" },
];

describe("mentionTargets", () => {
  test("a @Role typed by hand resolves through the role registry", () => {
    expect(mentionTargets("@Backend apa tujuan project ini?", team).map((a) => a._id)).toEqual(["be"]);
    expect(mentionTargets("@DevOps cek CI", team).map((a) => a._id)).toEqual(["ops"]);
    // A retired alias and a role title resolve the same way as a picked chip.
    expect(mentionTargets("@support tolong cek", team).map((a) => a._id)).toEqual(["be"]);
    expect(mentionTargets("@Backend Developer halo", team).map((a) => a._id)).toEqual(["be"]);
  });

  test("an @Name picks that agent, and an id already picked is not repeated", () => {
    expect(mentionTargets("@Eir lihat halaman About", team).map((a) => a._id)).toEqual(["fe"]);
    expect(mentionTargets("@Frontend dan @Eir", team, [team[2]!])).toEqual([]);
  });

  test("prose with no mention, or an unknown name, picks nobody", () => {
    expect(mentionTargets("apa kabar?", team)).toEqual([]);
    expect(mentionTargets("@Wizard halo", team)).toEqual([]);
    expect(mentionTargets("me@example.com", team)).toEqual([]);
  });
});
