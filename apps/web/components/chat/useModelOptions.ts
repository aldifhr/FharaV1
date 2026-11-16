"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";

export type ModelOption = { id: string; label: string; provider: string };

/**
 * Plan 055 + 060: the registry rows the composer's model picker can offer, in
 * the global list order. Skips models marked unavailable and disabled provider
 * connections. OpenCode rows stay: plan 060 routes a picked OpenCode model to
 * the worker bridge in `resolveConfigFromProviders`. `undefined` while loading.
 */
export function useModelOptions(): ModelOption[] | undefined {
  const llmModels = useQuery(api.llmModels.list, {});
  const llmProviders = useQuery(api.llmProviders.list, {});
  return useMemo(() => {
    if (llmModels === undefined || llmProviders === undefined) return undefined;
    const providerById = new Map((llmProviders as any[]).map((p) => [String(p._id), p]));
    const options: ModelOption[] = [];
    for (const m of llmModels as any[]) {
      if (m.isAvailable === false) continue;
      const p = providerById.get(String(m.providerId));
      if (!p || p.isEnabled === false) continue;
      options.push({ id: String(m._id), label: String(m.displayName ?? m.modelId), provider: String(p.name ?? p.provider ?? "") });
    }
    return options;
  }, [llmModels, llmProviders]);
}
