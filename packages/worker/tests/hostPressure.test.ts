import { describe, expect, it, vi } from "vitest";
import {
  claimUnlessPressured,
  classifyPressure,
  DEFAULT_PRESSURE_THRESHOLDS,
  HostPressureMonitor,
  OK_STATE,
  pressureCapability,
  thresholdsFromCritical,
  type HostSample,
} from "@/utils/hostPressure";

const T = thresholdsFromCritical({ memoryCriticalPct: 95, diskCriticalPct: 95, diskCriticalFreeGiB: 2, loadCriticalPct: 400 });
const calm: HostSample = { memoryUsedPct: 40, diskUsedPct: 50, diskFreeGiB: 200, loadPct: 50 };

describe("host pressure classifier", () => {
  it("derives warn limits from the critical ones", () => {
    expect(T).toMatchObject({ memoryWarnPct: 85, diskWarnPct: 90, diskWarnFreeGiB: 6, loadWarnPct: 300 });
    expect(DEFAULT_PRESSURE_THRESHOLDS).toEqual(T);
  });

  it("a calm host is ok", () => {
    expect(classifyPressure(calm, T)).toMatchObject({ level: "ok", reasons: [] });
  });

  it("memory hysteresis: enters at the limit, stays until it falls back past the margin", () => {
    let s = classifyPressure({ ...calm, memoryUsedPct: 95 }, T);
    expect(s.resources.memory).toBe("critical");
    // Just under the limit, inside the 3-point margin: still critical.
    s = classifyPressure({ ...calm, memoryUsedPct: 93 }, T, s);
    expect(s.level).toBe("critical");
    // Below 92: drops to warn (still above the warn limit 85).
    s = classifyPressure({ ...calm, memoryUsedPct: 91 }, T, s);
    expect(s.level).toBe("warn");
    // Warn holds down to 82, then ok.
    s = classifyPressure({ ...calm, memoryUsedPct: 83 }, T, s);
    expect(s.level).toBe("warn");
    s = classifyPressure({ ...calm, memoryUsedPct: 81 }, T, s);
    expect(s.level).toBe("ok");
    // From ok, 93 is only warn: the margin applies to leaving, not entering.
    expect(classifyPressure({ ...calm, memoryUsedPct: 93 }, T, s).level).toBe("warn");
  });

  it("load hysteresis uses a relative margin", () => {
    let s = classifyPressure({ ...calm, loadPct: 400 }, T);
    expect(s.resources.load).toBe("critical");
    s = classifyPressure({ ...calm, loadPct: 350 }, T, s); // ≥ 340 (0.85 × 400)
    expect(s.resources.load).toBe("critical");
    s = classifyPressure({ ...calm, loadPct: 330 }, T, s);
    expect(s.resources.load).toBe("warn");
  });

  it("disk needs BOTH its percent and GiB limits to trip", () => {
    // Very full but lots of room (big disk): ok.
    expect(classifyPressure({ ...calm, diskUsedPct: 99, diskFreeGiB: 40 }, T).resources.disk).toBe("ok");
    // Little room but a low percent (small disk): ok.
    expect(classifyPressure({ ...calm, diskUsedPct: 60, diskFreeGiB: 1 }, T).resources.disk).toBe("ok");
    // Both: critical.
    const crit = classifyPressure({ ...calm, diskUsedPct: 96, diskFreeGiB: 1.5 }, T);
    expect(crit.resources.disk).toBe("critical");
    expect(crit.reasons).toEqual(["disk 96% used, 1.5 GiB free"]);
    // Warn needs both of its own limits (90 % and 6 GiB).
    expect(classifyPressure({ ...calm, diskUsedPct: 91, diskFreeGiB: 5 }, T).resources.disk).toBe("warn");
    expect(classifyPressure({ ...calm, diskUsedPct: 91, diskFreeGiB: 7 }, T).resources.disk).toBe("ok");
  });

  it("disk hysteresis: leaving critical needs either limit to clear its margin", () => {
    let s = classifyPressure({ ...calm, diskUsedPct: 96, diskFreeGiB: 1.5 }, T);
    // Freed a little: 2.3 GiB is within the 0.5 GiB margin of 2 → still critical.
    s = classifyPressure({ ...calm, diskUsedPct: 94, diskFreeGiB: 2.3 }, T, s);
    expect(s.resources.disk).toBe("critical");
    // 3 GiB free clears the GiB margin → warn (still 94 % and ≤ 6 GiB).
    s = classifyPressure({ ...calm, diskUsedPct: 94, diskFreeGiB: 3 }, T, s);
    expect(s.resources.disk).toBe("warn");
  });

  it("the overall level is the worst resource, and 0 turns a resource off", () => {
    const s = classifyPressure({ ...calm, memoryUsedPct: 88, loadPct: 500 }, T);
    expect(s.level).toBe("critical");
    expect(s.resources).toEqual({ memory: "warn", disk: "ok", load: "critical" });
    const off = thresholdsFromCritical({ memoryCriticalPct: 0, diskCriticalPct: 0, diskCriticalFreeGiB: 2, loadCriticalPct: 0 });
    expect(classifyPressure({ memoryUsedPct: 100, diskUsedPct: 100, diskFreeGiB: 0, loadPct: 9999 }, off).level).toBe("ok");
  });

  it("the heartbeat capability names the level and the hot resources", () => {
    expect(pressureCapability(OK_STATE)).toBeNull();
    const s = classifyPressure({ ...calm, memoryUsedPct: 97, diskUsedPct: 96, diskFreeGiB: 1, loadPct: 500 }, T);
    const cap = pressureCapability(s)!;
    expect(cap).toBe("pressure:critical:memory,disk,load");
    expect(cap.length).toBeLessThanOrEqual(40);
  });
});

describe("host pressure monitor", () => {
  it("keeps state between samples and caches within the interval", () => {
    let now = 0;
    const samples: HostSample[] = [
      { ...calm, memoryUsedPct: 96 },
      { ...calm, memoryUsedPct: 93 },
    ];
    const sample = vi.fn(() => samples.shift()!);
    const m = new HostPressureMonitor({ thresholds: T, diskPath: "/", sample, now: () => now, minIntervalMs: 1000 });
    expect(m.check().level).toBe("critical");
    now = 500;
    expect(m.check().level).toBe("critical");
    expect(sample).toHaveBeenCalledTimes(1);
    now = 1500;
    expect(m.check().level).toBe("critical"); // 93 inside the margin
    expect(sample).toHaveBeenCalledTimes(2);
  });

  it("disabled reports ok; a failing sample keeps the last state", () => {
    expect(new HostPressureMonitor({ thresholds: T, diskPath: "/", enabled: false, sample: () => ({ ...calm, memoryUsedPct: 99 }) }).check().level).toBe("ok");
    let now = 0;
    let fail = false;
    const m = new HostPressureMonitor({
      thresholds: T,
      diskPath: "/",
      now: () => now,
      minIntervalMs: 0,
      sample: () => {
        if (fail) throw new Error("boom");
        return { ...calm, memoryUsedPct: 99 };
      },
    });
    expect(m.check().level).toBe("critical");
    fail = true;
    now = 10;
    expect(m.check().level).toBe("critical");
  });

  it("samples the real host without throwing", () => {
    const s = new HostPressureMonitor({ thresholds: T, diskPath: process.cwd() }).check();
    expect(["ok", "warn", "critical"]).toContain(s.level);
    expect(s.sample?.diskFreeGiB).toBeGreaterThan(0);
  });
});

describe("claim gate", () => {
  it("a claim at critical is deferred, not failed: the claim is never attempted", async () => {
    const critical = classifyPressure({ ...calm, diskUsedPct: 97, diskFreeGiB: 1 }, T);
    const claim = vi.fn(async () => ({ _id: "t1" }));
    const fail = vi.fn();
    const result = await claimUnlessPressured(critical, claim, 10_000);
    if (result.kind !== "deferred") fail();
    expect(result).toMatchObject({ kind: "deferred", retryAfterMs: 10_000 });
    expect(claim).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it("the deferred claim goes through once pressure clears", async () => {
    let s = classifyPressure({ ...calm, memoryUsedPct: 97 }, T);
    const claim = vi.fn(async () => ({ _id: "t1" }));
    expect((await claimUnlessPressured(s, claim, 1)).kind).toBe("deferred");
    s = classifyPressure({ ...calm, memoryUsedPct: 70 }, T, s);
    expect(await claimUnlessPressured(s, claim, 1)).toEqual({ kind: "claimed", value: { _id: "t1" } });
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("warn still claims; an empty queue reports empty", async () => {
    const warn = classifyPressure({ ...calm, memoryUsedPct: 88 }, T);
    expect(await claimUnlessPressured(warn, async () => ({ id: 1 }), 1)).toEqual({ kind: "claimed", value: { id: 1 } });
    expect(await claimUnlessPressured(OK_STATE, async () => null, 1)).toEqual({ kind: "empty" });
  });
});
