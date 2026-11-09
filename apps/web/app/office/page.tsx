"use client";

import { Suspense, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { Moon, Sun, SunMoon, Volume2, VolumeX } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import { useHydrated } from "@/lib/useHydrated";
import { useFharaOfficeFeed } from "@/components/office/useFharaOfficeFeed";
import type { DayNightMode } from "@/components/office/OfficeView";
import * as sfx from "@/components/office/engine/sounds";

// The canvas runs an animation loop and reads the clock: client only.
const OfficeView = dynamic(() => import("@/components/office/OfficeView"), { ssr: false });

const LAST_PROJECT_KEY = "fhara:office:project";

type Project = { _id: string; name: string };

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const DAY_NIGHT_NEXT: Record<DayNightMode, DayNightMode> = { auto: "day", day: "night", night: "auto" };
const DAY_NIGHT_LABEL: Record<DayNightMode, string> = { auto: "Otomatis", day: "Siang", night: "Malam" };

function OfficePage() {
  const router = useRouter();
  const params = useSearchParams();
  const hydrated = useHydrated();
  const projects = useQuery(api.projects.list, {}) as Project[] | undefined;
  const [stored, setStored] = useState<string | null>(null);
  const [dayNight, setDayNight] = useState<DayNightMode>("auto");
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    try {
      setStored(localStorage.getItem(LAST_PROJECT_KEY));
    } catch {
      /* storage blocked */
    }
  }, []);

  const fromUrl = params.get("project");
  const projectId =
    (fromUrl && projects?.some((p) => p._id === fromUrl) ? fromUrl : null) ??
    (stored && projects?.some((p) => p._id === stored) ? stored : null) ??
    projects?.[0]?._id ??
    null;

  useEffect(() => {
    if (!projectId) return;
    try {
      localStorage.setItem(LAST_PROJECT_KEY, projectId);
    } catch {
      /* storage blocked */
    }
  }, [projectId]);

  const { snapshot } = useFharaOfficeFeed(hydrated ? projectId : null);
  const project = projects?.find((p) => p._id === projectId);
  const working = snapshot?.agents.filter((a) => a.work === "working").length ?? 0;
  const waiting = snapshot?.approvals.length ?? 0;

  const subtitle = !hydrated || projects === undefined
    ? "Memuat…"
    : projects.length === 0
      ? "Belum ada project"
      : snapshot === undefined
        ? "Memuat…"
        : [
            `${snapshot.agents.length} agen`,
            working ? `${working} bekerja` : "semua santai",
            waiting ? `${waiting} menunggu keputusan` : null,
            snapshot.incident.active ? snapshot.incident.reason : null,
          ].filter(Boolean).join(" · ");

  const toggleSound = () => {
    const nowMuted = sfx.toggleMute();
    setMuted(nowMuted);
  };

  const DayIcon = dayNight === "auto" ? SunMoon : dayNight === "day" ? Sun : Moon;

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail projectId={projectId ?? undefined} />
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto px-6 py-8 max-[979px]:px-4 max-[979px]:py-6">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[26px] font-semibold tracking-tight">Office</h1>
            <p className="mt-1 text-[15px] text-ink-2">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {snapshot?.usage && (
              <span className="text-[13px] text-ink-3" title="Pemakaian token 24 jam terakhir di project ini">
                {formatTokens(snapshot.usage.tokens)} token
                {snapshot.usage.cost !== null ? ` · $${snapshot.usage.cost.toFixed(2)}` : ""} · 24 jam
              </span>
            )}
            <label className="sr-only" htmlFor="office-project">Project</label>
            <select
              id="office-project"
              value={projectId ?? ""}
              disabled={!projects || projects.length === 0}
              onChange={(e) => router.replace(`/office?project=${e.target.value}`)}
              className="h-8 max-w-[220px] rounded-lg border border-line bg-panel px-2 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              {(projects ?? []).map((p) => (
                <option key={p._id} value={p._id}>{p.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setDayNight((m) => DAY_NIGHT_NEXT[m])}
              title={`Siang/malam: ${DAY_NIGHT_LABEL[dayNight]}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[13px] text-ink-2 transition hover:bg-hover hover:text-ink"
            >
              <DayIcon size={14} /> {DAY_NIGHT_LABEL[dayNight]}
            </button>
            <button
              type="button"
              onClick={toggleSound}
              aria-label={muted ? "Nyalakan suara" : "Matikan suara"}
              title={muted ? "Nyalakan suara" : "Matikan suara"}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink-2 transition hover:bg-hover hover:text-ink"
            >
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
          </div>
        </header>

        {hydrated && projects !== undefined && projects.length === 0 ? (
          <p className="text-[14px] text-ink-2">Buat project dulu; agennya akan muncul di sini.</p>
        ) : snapshot === undefined || !project ? (
          <div className="aspect-[4800/3584] w-full max-w-[1100px] rounded-xl border border-line bg-panel" aria-label="Memuat office" />
        ) : (
          <OfficeView key={project._id} snapshot={snapshot} dayNight={dayNight} />
        )}

        <p className="mt-4 text-[12px] text-ink-3">
          Pixel art dan engine office dari{" "}
          <a href="https://github.com/W17ant/Claude-Office" target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
            Claude-Office
          </a>{" "}
          (MIT, © 2026 W17ANT).
        </p>
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <OfficePage />
    </Suspense>
  );
}
