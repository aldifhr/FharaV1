import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  effectiveTimeZone,
  formatTimeLine,
  normalizeTimeZone,
  TIME_CONTEXT_INTERVAL_MS,
  TimeContextThrottle,
  withTimeTail,
} from "@/api/convex/lib/timeContext";
import { splitPromptSections } from "@/api/convex/lib/contextSnapshot";
import { currentUserTimeZone, resetTimeContextForTest, setUserTimeZone, timeContextLine } from "@/context/timeContext";
import { turnUserContent } from "@/execution/turnContext";
import { planningPrompt } from "@/prompts/planner";
import { makeTempDir, removeTempDir } from "./helpers/tempRepo";

const T0 = Date.UTC(2026, 10, 11, 17, 24, 30); // Thu 2026-11-12 00:24:30 WIB

describe("time context (D4)", () => {
  afterEach(() => resetTimeContextForTest());

  it("formats the line in the zone, defaulting to Asia/Jakarta", () => {
    expect(formatTimeLine(T0, "Asia/Jakarta")).toBe("Current time: Thu 2026-11-12 00:24 (Asia/Jakarta, UTC+07:00).");
    expect(formatTimeLine(T0, "UTC")).toBe("Current time: Wed 2026-11-11 17:24 (UTC, UTC+00:00).");
    expect(formatTimeLine(T0, "Not/AZone")).toContain("(Asia/Jakarta, UTC+07:00)");
    expect(normalizeTimeZone("Mars/Base")).toBeNull();
    expect(effectiveTimeZone("")).toBe("Asia/Jakarta");
  });

  it("stamps at most once per 10 minutes per scope", () => {
    const throttle = new TimeContextThrottle();
    const first = throttle.line("task-a", T0, "Asia/Jakarta");
    // 9m59s later: the same line, byte for byte.
    expect(throttle.line("task-a", T0 + TIME_CONTEXT_INTERVAL_MS - 1000, "Asia/Jakarta")).toBe(first);
    // Another scope stamps its own time.
    expect(throttle.line("task-b", T0 + 5 * 60_000, "Asia/Jakarta")).toBe("Current time: Thu 2026-11-12 00:29 (Asia/Jakarta, UTC+07:00).");
    // After 10 minutes: re-stamped.
    expect(throttle.line("task-a", T0 + TIME_CONTEXT_INTERVAL_MS, "Asia/Jakarta")).toBe("Current time: Thu 2026-11-12 00:34 (Asia/Jakarta, UTC+07:00).");
    // A zone change re-stamps at once.
    expect(throttle.line("task-a", T0 + TIME_CONTEXT_INTERVAL_MS + 1000, "UTC")).toContain("(UTC, UTC+00:00)");
  });

  it("uses the Settings zone on the worker; an invalid zone falls back to Asia/Jakarta", () => {
    setUserTimeZone("Asia/Tokyo");
    expect(currentUserTimeZone()).toBe("Asia/Tokyo");
    expect(timeContextLine("w", T0)).toBe("Current time: Thu 2026-11-12 02:24 (Asia/Tokyo, UTC+09:00).");
    setUserTimeZone("bogus");
    expect(currentUserTimeZone()).toBe("Asia/Jakarta");
  });

  it("appends after history only when the last turn is the user's", () => {
    const history = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "what now?" },
    ];
    const out = withTimeTail(history, "Current time: X");
    expect(out.at(-1)?.content).toBe("what now?\n\nCurrent time: X");
    expect(out.slice(0, 3)).toEqual(history.slice(0, 3));
    const prefill = [...history, { role: "assistant", content: "partial" }];
    expect(withTimeTail(prefill, "Current time: X")).toBe(prefill);
  });

  it("a context snapshot shows the time line as the volatile tail, after history", () => {
    const repo = makeTempDir("fhara-d4-snap-");
    try {
      fs.writeFileSync(path.join(repo, "AGENTS.md"), "ROOT-RULE: keep it small.\n");
      const messages = [
        { role: "system", content: "You are the Frontend role." },
        { role: "user", content: "earlier turn" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: turnUserContent(repo, ["src/**"], ["Task: add a button"], T0) },
      ];
      const sections = splitPromptSections(messages);
      const keys = sections.map((section) => section.key);
      expect(keys.at(-1)).toBe("volatile");
      expect(keys.indexOf("history")).toBeLessThan(keys.indexOf("volatile"));
      expect(sections.at(-1)?.content).toBe("Current time: Thu 2026-11-12 00:24 (Asia/Jakarta, UTC+07:00).");
      expect(sections.find((section) => section.key === "shared")?.content).toContain("ROOT-RULE");
      expect(sections.find((section) => section.key === "user")?.content).toContain("Task: add a button");
    } finally {
      removeTempDir(repo);
    }
  });

  it("the planner prompt carries the chain near the top and the time line last", () => {
    const prompt = planningPrompt({
      command: "Add a button",
      classification: { kind: "code_change", complexity: "low", reasons: [], suggestedCapabilities: [], concerns: [], commands: [] } as never,
      policy: { maxReplans: 1, maxSubtasks: 4 },
      capabilityList: "",
      projectInstructions: "Project instructions (AGENTS.md; …):\n--- AGENTS.md ---\nROOT-RULE",
      timeLine: "Current time: Thu 2026-11-12 00:24 (Asia/Jakarta, UTC+07:00).",
    });
    expect(prompt.split("\n").at(-1)).toBe("Current time: Thu 2026-11-12 00:24 (Asia/Jakarta, UTC+07:00).");
    expect(prompt.indexOf("ROOT-RULE")).toBeLessThan(prompt.indexOf("Schema:"));
  });
});
