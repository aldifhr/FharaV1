"use client";
/*
 * The office canvas and the cards beside it. The canvas (room, furniture,
 * characters, whiteboard, incident layer, day/night) is adapted from
 * Claude-Office's src/App.tsx (https://github.com/W17ant/Claude-Office,
 * Copyright (c) 2026 W17ANT, MIT License, see /office/LICENSE-claude-office.txt);
 * the WebSocket, chat, boss and session plumbing are replaced by the
 * Convex feed (useFharaOfficeFeed -> feed.ts -> engine/officeReducer.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import "./office.css";
import { MAIN_ROOM } from "./engine/rooms";
import { findWaypointPath } from "./engine/pathing";
import { initialOfficeState, reduceOffice, stepOffice, type OfficeEffect, type OfficeEnv, type OfficeState } from "./engine/officeReducer";
import { getCurrentPhase, type DayPhase } from "./engine/daylight";
import * as sfx from "./engine/sounds";
import { diffOfficeSnapshots, type OfficeSnapshot } from "./feed";
import Character from "./parts/Character";
import FurnitureRenderer from "./parts/FurnitureRenderer";
import TaskBoard from "./parts/TaskBoard";
import IncidentLayer from "./parts/IncidentLayer";
import PermissionCards from "./parts/PermissionCards";
import AgentInspector from "./parts/AgentInspector";

const WAYPOINTS = MAIN_ROOM.waypoints ?? [];
const DAY_MS = 24 * 60 * 60 * 1000;

function env(): OfficeEnv {
  return {
    now: Date.now(),
    random: Math.random,
    computePath: (from, to) => findWaypointPath(from, to, WAYPOINTS),
  };
}

function playEffects(effects: OfficeEffect[]) {
  for (const e of effects) {
    switch (e.sfx) {
      case "doorOpen": sfx.playDoorOpen(); break;
      case "celebration": sfx.playCelebration(); break;
      case "alarm": sfx.playAlarm(); break;
      case "error": sfx.playError(); break;
      case "needsYou": sfx.playNeedsYou(); break;
      case "notification": sfx.playNotification(); break;
    }
  }
}

function nightFor(phase: DayPhase): number {
  return phase === "night" ? 1 : phase === "dusk" || phase === "dawn" ? 0.55 : phase === "evening" ? 0.2 : 0;
}

export type DayNightMode = "auto" | "day" | "night";

export default function OfficeView({ snapshot, dayNight }: { snapshot: OfficeSnapshot; dayNight: DayNightMode }) {
  const router = useRouter();
  const officeRef = useRef<OfficeState>(initialOfficeState());
  const prevSnap = useRef<OfficeSnapshot | null>(null);
  const [office, setOffice] = useState<OfficeState>(officeRef.current);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [phase, setPhase] = useState<DayPhase>(() => getCurrentPhase());
  const [now, setNow] = useState(() => Date.now());

  const commit = useCallback((next: OfficeState) => {
    officeRef.current = next;
    setOffice(next);
  }, []);

  // Feed -> actions -> reducer
  useEffect(() => {
    const actions = diffOfficeSnapshots(prevSnap.current, snapshot);
    prevSnap.current = snapshot;
    if (actions.length === 0) return;
    let state = officeRef.current;
    const effects: OfficeEffect[] = [];
    for (const action of actions) {
      const r = reduceOffice(state, action, env());
      state = r.state;
      effects.push(...r.effects);
    }
    commit(state);
    playEffects(effects);
  }, [snapshot, commit]);

  // Animation loop: walks, arrivals, breaks, scenes
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = t - last;
      last = t;
      const r = stepOffice(officeRef.current, dt, env());
      if (r.changed) commit(r.state);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [commit]);

  // Slow clock: day phase, sleeping bubbles, the alarm burst
  useEffect(() => {
    const timer = setInterval(() => {
      setPhase(getCurrentPhase());
      setNow(Date.now());
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  const incident = office.incident;
  const night = incident.active ? 1 : dayNight === "auto" ? nightFor(phase) : dayNight === "night" ? 1 : 0;
  const overlayPhase: DayPhase = incident.active ? "night" : dayNight === "auto" ? phase : dayNight === "night" ? "night" : "afternoon";
  const inspected = office.agents.find((a) => a.id === inspectedId) ?? null;
  const daysSince = snapshot.lastIncidentAt === null ? null : Math.max(0, Math.floor((now - snapshot.lastIncidentAt) / DAY_MS));
  const onCharacter = useCallback((id: string) => setInspectedId((prev) => (prev === id ? null : id)), []);
  const openTask = useCallback((taskId: string) => router.push(`/runs/${taskId}`), [router]);

  const characters = useMemo(
    () =>
      office.agents.map((agent) => {
        const spot = MAIN_ROOM.agentSpots.find((s) => s.id === agent.assignedSpotId);
        const atDesk = Math.abs(agent.position.x - agent.deskPosition.x) < 1 && Math.abs(agent.position.y - agent.deskPosition.y) < 1;
        const idleSince = office.meta[agent.id]?.idleSince;
        return (
          <Character
            key={agent.id}
            agent={agent}
            idleMs={agent.state === "idle" && idleSince ? now - idleSince : 0}
            zIndex={atDesk && spot?.zIndex ? spot.zIndex : undefined}
            incident={incident.active}
            onClick={onCharacter}
            inspected={agent.id === inspectedId}
          />
        );
      }),
    [office, now, incident.active, inspectedId, onCharacter],
  );

  return (
    <div className="flex min-h-0 flex-1 gap-4 max-[1100px]:flex-col">
      <div className="fo-office min-w-0 flex-1">
        <div className={`room-container overflow-hidden rounded-xl border border-line${incident.active ? " incident" : ""}`}>
          <div className="room-background" style={{ backgroundImage: "url(/office/rooms/office-day.png)" }} />
          <div className="room-background room-background-night" style={{ backgroundImage: "url(/office/rooms/office-night.png)", opacity: night }} />
          <FurnitureRenderer items={MAIN_ROOM.furniture} />
          <TaskBoard tasks={snapshot.board} night={night} onOpen={openTask} />
          {characters}
          <IncidentLayer active={incident.active} reason={incident.reason} since={incident.since} daysSince={daysSince} now={now} />
          <div className={`day-overlay ${overlayPhase}`} />
        </div>
      </div>
      <aside className="flex w-[320px] shrink-0 flex-col gap-3 overflow-y-auto max-[1100px]:w-full">
        {inspected && <AgentInspector agent={inspected} onClose={() => setInspectedId(null)} />}
        <PermissionCards cards={snapshot.approvals} highlightId={inspectedId} />
      </aside>
    </div>
  );
}
