"use client";
/*
 * Everything incident mode draws over the room. Adapted from Claude-Office
 * (https://github.com/W17ant/Claude-Office), src/components/IncidentLayer.tsx
 * and src/incidentAssets.ts. Copyright (c) 2026 W17ANT. MIT License, see
 * /office/LICENSE-claude-office.txt.
 *
 * Fhara port: driven by props (a failed task or push, from feed.ts) instead
 * of a module store; the slots use the shipped fallback art only (the
 * intended incident PNGs were never drawn upstream, so no probe 404s).
 */
import React from 'react'

const ART = {
  beacon: '/office/sprites/effects/fire.png',
  statusScreen: '/office/sprites/culture/deploying-screen.png',
  daysSign: '/office/sprites/culture/days-last-incident.png',
}

const DOOR_BEACON = { x: 69, y: 21 }
const TV_SCREEN = { x: 90.5, y: 36.5 }
const DAYS_SIGN = { x: 6.6, y: 30.5 }
const ALARM_MS = 6_000

interface IncidentLayerProps {
  active: boolean
  reason: string | null
  /** When the incident began (ms), for the alarm burst */
  since: number | null
  /** Whole days since the last failed task or push (null = never) */
  daysSince: number | null
  now: number
}

const IncidentLayer: React.FC<IncidentLayerProps> = ({ active, reason, since, daysSince, now }) => {
  const n = active ? 0 : daysSince ?? 0
  const size = n >= 100 ? ' three' : n >= 10 ? ' two' : ''
  return (
    <>
      <div
        className={`days-sign${active ? ' incident' : ''}`}
        style={{ left: `${DAYS_SIGN.x}%`, top: `${DAYS_SIGN.y}%` }}
        title={active ? `Hari sejak insiden terakhir: 0 (${reason ?? 'sedang terjadi'})` : `Hari sejak insiden terakhir: ${n}`}
      >
        <img src={ART.daysSign} alt="Hari sejak insiden terakhir" draggable={false} />
        <span className={`days-sign-digits${size}`}>{n}</span>
      </div>

      {active && (
        <>
          <div className="room-tint" aria-hidden="true" />
          {since !== null && now - since < ALARM_MS && <div key={since} className="room-alarm" aria-hidden="true" />}
          <div className="incident-beacon-sweep" style={{ left: `${DOOR_BEACON.x}%`, top: `${DOOR_BEACON.y}%` }} aria-hidden="true" />
          <div className="incident-beacon" style={{ left: `${DOOR_BEACON.x}%`, top: `${DOOR_BEACON.y}%` }} title={reason ?? 'Insiden'}>
            <img className="frame-a" src={ART.beacon} alt="" draggable={false} />
            <img className="frame-b" src={ART.beacon} alt="" draggable={false} />
          </div>
          <div className="incident-tv" style={{ left: `${TV_SCREEN.x}%`, top: `${TV_SCREEN.y}%` }} title={reason ?? 'Insiden'}>
            <img src={ART.statusScreen} alt="Status insiden" draggable={false} />
            <span className="incident-tv-label">GAGAL</span>
          </div>
        </>
      )}
    </>
  )
}

export default IncidentLayer
