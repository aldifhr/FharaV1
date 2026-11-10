import { describe, expect, test } from "vitest";
import { checkRunFact, commitStatusFact, fetchCommitChecks, summarizeChecks } from "./prChecks";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TOKEN = "gho_supersecrettoken1234567890abcdef";

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: Array<{ url: string; auth?: string }> = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const route = key ? routes[key]! : { status: 404 };
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), { status: route.status });
  };
  return { impl, calls };
}

describe("prChecks", () => {
  test("maps check runs like threadbear's ciVerdict (success/neutral/skipped pass)", () => {
    expect(checkRunFact({ name: "a", status: "completed", conclusion: "success" })?.status).toBe("passed");
    expect(checkRunFact({ name: "a", status: "completed", conclusion: "skipped" })?.status).toBe("passed");
    expect(checkRunFact({ name: "a", status: "completed", conclusion: "neutral" })?.status).toBe("passed");
    expect(checkRunFact({ name: "a", status: "completed", conclusion: "cancelled" })?.status).toBe("failed");
    expect(checkRunFact({ name: "a", status: "completed", conclusion: "timed_out" })?.status).toBe("failed");
    expect(checkRunFact({ name: "a", status: "in_progress", conclusion: null })?.status).toBe("pending");
    expect(checkRunFact({ status: "completed" })).toBeNull();
    expect(commitStatusFact({ context: "vercel", state: "error" })?.status).toBe("failed");
    expect(commitStatusFact({ context: "vercel", state: "pending" })?.status).toBe("pending");
  });

  test("summary: none, failure beats pending, pending beats success", () => {
    expect(summarizeChecks([]).state).toBe("none");
    expect(
      summarizeChecks([
        { name: "a", status: "pending" },
        { name: "b", status: "failed" },
      ])
    ).toMatchObject({ state: "failure", failed: 1, pending: 1, total: 2 });
    expect(summarizeChecks([{ name: "a", status: "pending" }, { name: "b", status: "passed" }]).state).toBe("pending");
    expect(summarizeChecks([{ name: "a", status: "passed" }]).state).toBe("success");
  });

  test("fetchCommitChecks merges check runs and statuses, failures first, bounded", async () => {
    const runs = Array.from({ length: 40 }, (_, i) => ({ id: i, name: `job ${i}`, status: "completed", conclusion: "success" }));
    runs.push({ id: 99, name: "e2e", status: "completed", conclusion: "failure" });
    const { impl, calls } = fakeFetch({
      "/check-runs": { status: 200, body: { check_runs: runs } },
      "/status": { status: 200, body: { statuses: [{ context: "e2e", state: "success" }, { context: "deploy", state: "pending" }] } },
    });
    const { checks, summary } = await fetchCommitChecks({ owner: "acme", repo: "app", sha: SHA, token: TOKEN, fetchImpl: impl });
    expect(checks).toHaveLength(30);
    expect(checks[0]).toMatchObject({ name: "e2e", status: "failed" });
    expect(summary.state).toBe("failure");
    expect(summary.url).toBe(`https://github.com/acme/app/commit/${SHA}/checks`);
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}` && !c.url.includes(TOKEN))).toBe(true);
  });

  test("404s mean no checks; other errors carry only the status", async () => {
    const none = await fetchCommitChecks({ owner: "a", repo: "b", sha: SHA, token: TOKEN, fetchImpl: fakeFetch({}).impl });
    expect(none.summary.state).toBe("none");
    const { impl } = fakeFetch({ "/check-runs": { status: 500, body: { message: TOKEN } } });
    await expect(fetchCommitChecks({ owner: "a", repo: "b", sha: SHA, token: TOKEN, fetchImpl: impl })).rejects.toThrow(
      /^GitHub checks request failed \(500\)$/
    );
    await expect(fetchCommitChecks({ owner: "a", repo: "b", sha: "nope", token: TOKEN, fetchImpl: impl })).rejects.toThrow(
      "Invalid commit sha"
    );
  });
});
