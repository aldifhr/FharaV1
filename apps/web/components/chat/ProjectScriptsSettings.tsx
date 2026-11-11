"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "../Toasts";
import {
  PROJECT_SCRIPT_ARGV,
  PROJECT_SCRIPT_HINTS,
  PROJECT_SCRIPT_KINDS,
  PROJECT_SCRIPT_LABELS,
  configuredProjectScript,
  projectScriptLine,
  type ProjectScriptKind,
} from "@/api/convex/lib/projectScriptsSchema";

const field = "rounded-lg border border-line bg-panel px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-brand/50 focus:ring-2 focus:ring-brand/15";

/**
 * GOAT G9 / T6: the project's setup and check scripts. Each is one choice
 * from the exact-argv allowlist (or none), saved as soon as it changes.
 */
export default function ProjectScriptsSettings({ projectId, scripts }: { projectId: string; scripts?: unknown }) {
  const setScripts = useMutation(api.projectScripts.set);
  const toast = useToast();
  const [saving, setSaving] = useState<ProjectScriptKind | null>(null);

  async function change(kind: ProjectScriptKind, line: string) {
    setSaving(kind);
    try {
      await setScripts({ projectId: projectId as never, [kind]: line });
      toast("success", `${PROJECT_SCRIPT_LABELS[kind]} ${line ? "saved" : "cleared"}`, line || undefined);
    } catch (err) {
      toast("error", `Couldn't save the ${PROJECT_SCRIPT_LABELS[kind].toLowerCase()}`, err instanceof Error ? err.message : "Please try again.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <fieldset className="grid gap-2">
      <legend className="font-medium">Scripts</legend>
      {PROJECT_SCRIPT_KINDS.map((kind) => {
        const current = configuredProjectScript(scripts, kind);
        return (
          <label key={kind} className="grid gap-1">
            {PROJECT_SCRIPT_LABELS[kind]}
            <select
              value={current ? projectScriptLine(current) : ""}
              onChange={(e) => void change(kind, e.target.value)}
              disabled={saving === kind}
              className={`${field} disabled:opacity-50`}
            >
              <option value="">{kind === "check" ? "No check" : "No setup script"}</option>
              {PROJECT_SCRIPT_ARGV[kind].map((argv) => {
                const line = projectScriptLine(argv);
                return (
                  <option key={line} value={line}>
                    {line}
                  </option>
                );
              })}
            </select>
            <span className="text-[12.5px] text-ink-3">{PROJECT_SCRIPT_HINTS[kind]}</span>
          </label>
        );
      })}
    </fieldset>
  );
}
