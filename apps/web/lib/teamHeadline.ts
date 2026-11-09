/**
 * The Team page summary line. `loaded` must be false on the server AND on
 * the first client (hydration) render, so both render "Loading…" and React
 * never sees a text mismatch ("Loading…" vs "9 agents · all idle").
 */
export function teamHeadline(loaded: boolean, count: number, busy: number): string {
  if (!loaded) return "Loading…";
  return `${count} ${count === 1 ? "agent" : "agents"} · ${busy ? `${busy} working now` : "all idle"}`;
}

/** The roster is ready to show only after hydration and once the query answered. */
export function teamLoaded(hydrated: boolean, agents: unknown[] | undefined): boolean {
  return hydrated && agents !== undefined;
}
