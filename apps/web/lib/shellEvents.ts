/** Cross-component shell signals (rail → sidebar). */
const FOCUS_TEAM = "fhara:focus-team";

export function focusTeam(): void {
  window.dispatchEvent(new Event(FOCUS_TEAM));
}

export function onFocusTeam(handler: () => void): () => void {
  window.addEventListener(FOCUS_TEAM, handler);
  return () => window.removeEventListener(FOCUS_TEAM, handler);
}
