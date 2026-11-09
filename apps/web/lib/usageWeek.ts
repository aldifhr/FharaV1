/**
 * Weekly usage window. The meter resets every Monday 09:00 in the user's
 * own timezone; the start is computed on the client so the server never
 * guesses a timezone.
 */
const RESET_WEEKDAY = 1; // Monday
const RESET_HOUR = 9;

export function lastWeeklyReset(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(RESET_HOUR, 0, 0, 0);
  const diff = (d.getDay() - RESET_WEEKDAY + 7) % 7;
  d.setDate(d.getDate() - diff);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 7);
  return d;
}

export function nextWeeklyReset(now = new Date()): Date {
  const d = lastWeeklyReset(now);
  d.setDate(d.getDate() + 7);
  return d;
}

export function resetLabel(now = new Date()): string {
  const next = nextWeeklyReset(now);
  const day = next.toLocaleDateString("en-US", { weekday: "short" });
  const time = next.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `Resets ${day} ${time}`;
}

/** "Claude", "GPT", … from a model id / provider kind; falls back to name. */
export function llmDisplayName(model: string | null, providerKind: string | null, providerName: string | null): string {
  const hay = `${model ?? ""} ${providerKind ?? ""}`.toLowerCase();
  if (hay.includes("claude") || hay.includes("anthropic")) return "Claude";
  if (hay.includes("gpt") || hay.includes("openai") || /\bo[134]\b/.test(hay)) return "GPT";
  if (hay.includes("gemini") || hay.includes("google")) return "Gemini";
  if (hay.includes("deepseek")) return "DeepSeek";
  if (hay.includes("mistral")) return "Mistral";
  if (hay.includes("llama")) return "Llama";
  if (hay.includes("qwen")) return "Qwen";
  return providerName ?? model ?? "LLM";
}

/** Local override of the weekly token budget (Settings), else the server's. */
export const BUDGET_STORAGE_KEY = "moagent-weekly-token-budget";

export function readLocalBudget(): number | null {
  try {
    const raw = Number(localStorage.getItem(BUDGET_STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}
