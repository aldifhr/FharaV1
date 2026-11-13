/** Local override of the weekly token budget (Settings), else the server's. */
export const BUDGET_STORAGE_KEY = "fhara-weekly-token-budget";

export function readLocalBudget(): number | null {
  try {
    const raw = Number(localStorage.getItem(BUDGET_STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}
