"use client";

/**
 * Plan 034: the OpenCode model picker.
 *
 * The models the local OpenCode CLI can run live on the worker machine
 * (`opencode models`). The worker publishes the list; this reads it and
 * offers the ids as a dropdown. "Fhara LLM (default)" leaves the model
 * empty, which points OpenCode at Fhara's own LLM.
 * "Custom…" keeps the free-text field for a model the CLI does not list.
 *
 * Plan 035: the model is app-wide (Settings → LLM & Models), not per agent.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { RefreshCw } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { relativeTime } from "@/lib/runFormat";

const FIELD =
  "w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[14px] text-ink outline-none transition focus:border-ink-3 disabled:opacity-40";
const LABEL = "grid gap-1.5 text-[12.5px] text-ink-3";
const HINT = "text-[12px] text-ink-3";
const CUSTOM = "__custom__";

type Catalog = {
  models: string[];
  available: boolean;
  error: string | null;
  updatedAt: number;
  workerId: string | null;
  hostname: string | null;
  pendingRefresh: boolean;
  reportedWorkers: number;
};

/** Models grouped by provider, both sorted, for <optgroup> sections. */
function groupByProvider(models: string[]): Array<{ provider: string; models: string[] }> {
  const groups = new Map<string, string[]>();
  for (const model of models) {
    const slash = model.indexOf("/");
    const provider = slash > 0 ? model.slice(0, slash) : model;
    const list = groups.get(provider) ?? [];
    list.push(model);
    groups.set(provider, list);
  }
  return [...groups.entries()]
    .map(([provider, list]) => ({ provider, models: [...list].sort() }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

export function OpencodeModelField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const catalog = useQuery(api.opencodeModels.list, {}) as Catalog | undefined;
  const requestRefresh = useMutation(api.opencodeModels.requestRefresh);
  const [custom, setCustom] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const models = catalog?.models ?? [];
  const groups = useMemo(() => groupByProvider(models), [models]);
  const known = models.includes(value);
  const selectValue = value === "" ? "" : custom || !known ? CUSTOM : value;
  const showInput = custom || (value !== "" && !known);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await requestRefresh({});
    } finally {
      setRefreshing(false);
    }
  };

  let status = "Waiting for the worker to report an OpenCode model list…";
  if (catalog) {
    if (catalog.reportedWorkers === 0) {
      status = "No worker has reported an OpenCode model list yet.";
    } else if (!catalog.available) {
      status = `OpenCode CLI unavailable: ${catalog.error ?? "unknown error"}`;
    } else {
      const who = catalog.hostname ?? catalog.workerId ?? "worker";
      status = `${catalog.models.length} model${catalog.models.length === 1 ? "" : "s"} from ${who} · updated ${relativeTime(catalog.updatedAt)}`;
    }
  }

  return (
    <div className="grid gap-1.5">
      <span className={LABEL}>OpenCode model</span>
      <select
        aria-label="OpenCode model"
        value={selectValue}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          if (next === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(next);
        }}
        className={FIELD}
      >
        <option value="">Fhara LLM (default)</option>
        {groups.map((group) => (
          <optgroup key={group.provider} label={group.provider}>
            {group.models.map((model) => (
              <option key={model} value={model}>
                {model.slice(group.provider.length + 1)}
              </option>
            ))}
          </optgroup>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {showInput && (
        <input
          value={value}
          onChange={(event) => {
            setCustom(true);
            onChange(event.target.value);
          }}
          placeholder="provider/model"
          aria-label="Custom OpenCode model"
          className={FIELD}
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <span className={HINT}>
          {status}
          {catalog?.pendingRefresh ? " · refresh requested" : ""}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12.5px] text-ink-2 transition hover:bg-hover disabled:opacity-50"
        >
          <RefreshCw size={12} /> {refreshing ? "Asking…" : "Refresh"}
        </button>
      </div>
    </div>
  );
}
