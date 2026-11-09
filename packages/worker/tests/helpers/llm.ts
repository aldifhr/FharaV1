import type { LLMProvider, LLMResult } from "@/llm";

/** A provider that always answers with the same result. */
export function fixedProvider(result: LLMResult | string): LLMProvider {
  const value = typeof result === "string" ? { content: result } : result;
  return { complete: async () => value };
}

/**
 * A provider that plays a script: each call takes the next step — a
 * result to return or an Error to throw. The last step repeats. `calls`
 * counts completions.
 */
export function scriptedProvider(steps: Array<LLMResult | string | Error>): LLMProvider & { calls: number } {
  const provider = {
    calls: 0,
    complete: async (): Promise<LLMResult> => {
      const step = steps[Math.min(provider.calls, steps.length - 1)];
      provider.calls += 1;
      if (step instanceof Error) throw step;
      return typeof step === "string" ? { content: step } : step;
    },
  };
  return provider;
}

/** A provider whose calls never settle (timeout / abort tests). */
export function hangingProvider(): LLMProvider {
  return { complete: () => new Promise(() => {}) };
}
