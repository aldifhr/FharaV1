import { NextResponse } from "next/server";

/**
 * Plan 067: a random display name for agents, fetched from a public
 * name API (randomuser.me, no key) through this server route — the browser
 * never calls the third party directly, so CORS and availability live in
 * one place. There is no hardcoded name list anywhere: when the API is
 * unreachable the fallback is a synthetic id-style name ("Agent-x7k2"),
 * reported honestly via `source`.
 */
export async function GET() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const res = await fetch("https://randomuser.me/api/?inc=name&noinfo", {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`randomuser responded ${res.status}`);
    const data = (await res.json()) as { results?: Array<{ name?: { first?: string; last?: string } }> };
    const name = data.results?.[0]?.name;
    // First name only (developer preference for agent display names).
    const full = String(name?.first ?? "").trim();
    if (!full) throw new Error("the response carried no name");
    return NextResponse.json({ name: full, source: "api" });
  } catch (error) {
    const fallback = `Agent-${Math.random().toString(36).slice(2, 6)}`;
    return NextResponse.json({
      name: fallback,
      source: "fallback",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
}
