"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { AlertTriangle } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import type { Id } from "@/api/convex/_generated/dataModel";
import type { SideEffectCardData } from "@/api/convex/cardTypes";
import { useToast } from "../../Toasts";
import { BTN_OUTLINE, BTN_PRIMARY, BTN_TEXT, CardHeader, CardShell, IconTile, MUTED } from "./primitives";
import { StatusTag } from "../../ui/status-tag";

const PHASE_WORD: Record<string, { tone: "warn" | "ok" | "neutral" | "active"; label: string }> = {
  ambiguous: { tone: "warn", label: "Needs you" },
  armed: { tone: "active", label: "Checking" },
  queued: { tone: "active", label: "Retrying" },
  accepted: { tone: "active", label: "Checking" },
  terminal: { tone: "ok", label: "Settled" },
};

/**
 * L6: Fhara could not confirm whether a push / PR / apply happened after an
 * interruption. Check asks reality again (never writes), Mark done takes
 * the user's word, Retry lets the write run again — only on this click.
 */
export default function SideEffectCard({ data }: { data: SideEffectCardData }) {
  const toast = useToast();
  const view = useQuery(api.sideEffects.get, { effectId: data.effectId as Id<"sideEffects"> });
  const resolve = useMutation(api.sideEffects.resolve);
  const [acting, setActing] = useState<string | null>(null);
  const phase = view?.phase ?? "ambiguous";
  const word = PHASE_WORD[phase] ?? PHASE_WORD.ambiguous;
  const open = phase === "ambiguous";

  const run = async (action: "check" | "mark_done" | "retry") => {
    setActing(action);
    try {
      await resolve({ effectId: data.effectId as Id<"sideEffects">, action });
    } catch (err) {
      toast("error", "Couldn't record your choice", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setActing(null);
    }
  };

  return (
    <CardShell
      className="max-w-xl"
      header={
        <CardHeader
          icon={
            <IconTile tone="warn">
              <AlertTriangle size={15} />
            </IconTile>
          }
          title={`Fhara could not confirm whether ${data.label} happened`}
          subtitle={view?.reason ?? undefined}
          pill={<StatusTag tone={word.tone}>{phase === "terminal" && view?.outcome === "failed" ? "Failed" : word.label}</StatusTag>}
        />
      }
      actions={
        open ? (
          <>
            <button type="button" disabled={acting !== null} onClick={() => void run("check")} className={BTN_PRIMARY}>
              {acting === "check" ? "Checking…" : "Check"}
            </button>
            <button type="button" disabled={acting !== null} onClick={() => void run("mark_done")} className={BTN_OUTLINE}>
              Mark done
            </button>
            <button type="button" disabled={acting !== null} onClick={() => void run("retry")} className={BTN_TEXT}>
              Retry
            </button>
            <span className={`ml-auto text-[12px] ${MUTED}`}>Nothing is repeated until you choose.</span>
          </>
        ) : undefined
      }
    />
  );
}
