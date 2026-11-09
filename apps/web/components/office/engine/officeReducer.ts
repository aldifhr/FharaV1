/*
 * The office state machine. Adapted from Claude-Office
 * (https://github.com/W17ant/Claude-Office), src/officeReducer.ts.
 * Copyright (c) 2026 W17ANT. MIT License, see /office/LICENSE-claude-office.txt.
 *
 * Same shape as the original: a pure reduceOffice(state, action, env) for
 * the events and a pure stepOffice(state, dt, env) for the animation frame,
 * with every impure input (clock, randomness, pathfinding) injected through
 * env. The Claude Code session/boss/hook handling is replaced by Fhara's
 * five actions (see ../feed.ts OfficeAction): hire, leave, status,
 * incident, celebrate.
 */

import type { Agent, Position } from './types'
import { MAIN_ROOM, type AgentSpot } from './rooms'
import { WALK_SPEED, stepToward } from './pathing'
import type { OfficeAction, SnapAgent } from '../feed'

export const ENTRY: Position = { x: MAIN_ROOM.entryPoint.x, y: MAIN_ROOM.entryPoint.y }
/** How long an agent stands at the coffee machine */
export const BREAK_MS = 8_000
/** Celebration bubbles after a push */
export const CELEBRATE_MS = 6_000
const ARRIVAL = 0.3

export interface AgentMeta {
  /** What to show once the agent reaches its desk */
  pending?: SnapAgent
  /** Standing at the coffee machine until */
  breakUntil?: number
  /** Took its coffee break for the current idle spell */
  breakDone?: boolean
  /** When the agent last became idle at its desk */
  idleSince?: number
  lobbySlot?: number
}

export interface OfficeState {
  agents: Agent[]
  meta: Record<string, AgentMeta>
  incident: { active: boolean; reason: string | null; since: number | null }
}

export interface OfficeEnv {
  now: number
  random: () => number
  computePath: (from: Position, to: Position) => Position[]
}

export type SfxName = 'doorOpen' | 'celebration' | 'alarm' | 'error' | 'needsYou' | 'notification'
export type OfficeEffect = { kind: 'sfx'; sfx: SfxName }

export interface OfficeResult { state: OfficeState; effects: OfficeEffect[] }
export interface StepResult extends OfficeResult { changed: boolean }

export function initialOfficeState(): OfficeState {
  return { agents: [], meta: {}, incident: { active: false, reason: null, since: null } }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DESKS = MAIN_ROOM.agentSpots.filter(s => s.type === 'desk')
const COFFEE = MAIN_ROOM.agentSpots.filter(s => s.type === 'coffee' || s.type === 'water')

function near(a: Position, b: Position): boolean {
  return Math.abs(a.x - b.x) < ARRIVAL && Math.abs(a.y - b.y) < ARRIVAL
}

function freeDesk(agents: Agent[]): AgentSpot | null {
  const taken = new Set(agents.filter(a => a.state !== 'leaving').map(a => a.assignedSpotId).filter(Boolean))
  return DESKS.find(s => !taken.has(s.id)) ?? null
}

/** Where the n-th agent without a desk stands: along the wall either side of the door. */
export function lobbyPosition(slot: number): Position {
  const side = slot % 2 === 0 ? -1 : 1
  const rank = Math.floor(slot / 2)
  return { x: ENTRY.x + side * (3.5 + rank * 2.6), y: ENTRY.y + side * (2.3 + rank * 1.7) }
}

function freeLobbySlot(meta: Record<string, AgentMeta>, agents: Agent[]): number {
  const used = new Set(agents.filter(a => a.state === 'waiting').map(a => meta[a.id]?.lobbySlot).filter((n): n is number => n !== undefined))
  let slot = 0
  while (used.has(slot)) slot++
  return slot
}

function isAtDesk(a: Agent): boolean {
  return !!a.assignedSpotId && near(a.position, a.deskPosition) && (a.pathQueue?.length ?? 0) === 0
}

/** Labels that follow the feed at once, wherever the character stands. */
function withLabels(a: Agent, s: SnapAgent, now: number): Agent {
  return {
    ...a,
    name: s.name,
    charBase: s.charBase,
    color: s.color,
    task: s.taskTitle,
    taskId: s.taskId,
    subtaskKey: s.subtaskKey,
    statusText: s.statusText,
    needsYou: s.work === 'needs_you' ? s.needsYou : undefined,
    lastFailed: s.work === 'failed',
    scene: s.work === 'failed' ? { kind: 'red', until: now + 60_000 } : a.scene?.kind === 'red' ? undefined : a.scene,
  }
}

function walkTo(a: Agent, target: Position, env: OfficeEnv): Agent {
  return { ...a, targetPosition: { ...target }, pathQueue: env.computePath(a.position, target) }
}

/**
 * The agent is at its desk: show what the feed says. Idle starts one
 * coffee break per idle spell; the agent then dozes at its desk.
 */
function settle(state: OfficeState, a: Agent, s: SnapAgent, env: OfficeEnv): OfficeState {
  const meta = { ...(state.meta[a.id] ?? {}), pending: undefined }
  let next: Agent = withLabels(a, s, env.now)
  if (s.work === 'idle') {
    if (!meta.breakDone) {
      const taken = new Set(state.agents.filter(x => x.state === 'coffee-break').map(x => `${x.targetPosition.x},${x.targetPosition.y}`))
      const spot = COFFEE.find(c => !taken.has(`${c.x},${c.y}`)) ?? COFFEE[0]
      if (spot) {
        next = walkTo({ ...next, state: 'coffee-break', spriteFacing: spot.spriteFacing, statusText: 'rehat kopi' }, spot, env)
        meta.breakUntil = undefined
        return replace(state, next, meta)
      }
    }
    next = { ...next, state: 'idle', statusText: 'santai', spriteFacing: deskFacing(a) }
    meta.idleSince = meta.idleSince ?? env.now
    return replace(state, next, meta)
  }
  meta.breakDone = false
  meta.idleSince = undefined
  next = { ...next, state: s.work === 'completed' ? 'completed' : s.work === 'failed' ? 'idle' : 'working', spriteFacing: deskFacing(a) }
  return replace(state, next, meta)
}

function deskFacing(a: Agent) {
  return DESKS.find(d => d.id === a.assignedSpotId)?.spriteFacing ?? a.spriteFacing
}

function replace(state: OfficeState, agent: Agent, meta?: AgentMeta): OfficeState {
  return {
    ...state,
    agents: state.agents.map(x => (x.id === agent.id ? agent : x)),
    meta: meta ? { ...state.meta, [agent.id]: meta } : state.meta,
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function reduceOffice(state: OfficeState, action: OfficeAction, env: OfficeEnv): OfficeResult {
  switch (action.type) {
    case 'hire': {
      const s = action.agent
      if (state.agents.some(a => a.id === s.id)) return reduceOffice(state, { type: 'status', agent: s }, env)
      const desk = freeDesk(state.agents)
      const base: Agent = {
        id: s.id,
        name: s.name,
        role: s.role,
        charBase: s.charBase,
        color: s.color,
        state: desk ? 'new-hire' : 'waiting',
        position: { ...ENTRY },
        targetPosition: { ...ENTRY },
        deskPosition: desk ? { x: desk.x, y: desk.y } : { ...ENTRY },
        assignedSpotId: desk?.id,
        spriteFacing: desk?.spriteFacing,
        hiredAt: env.now,
      }
      const labelled = { ...withLabels(base, s, env.now), state: base.state }
      const meta: AgentMeta = { pending: s }
      let agent: Agent
      if (desk) {
        agent = walkTo(labelled, base.deskPosition, env)
      } else {
        meta.lobbySlot = freeLobbySlot(state.meta, state.agents)
        agent = walkTo(labelled, lobbyPosition(meta.lobbySlot), env)
        agent = { ...agent, pathQueue: [] }
      }
      return {
        state: { ...state, agents: [...state.agents, agent], meta: { ...state.meta, [s.id]: meta } },
        effects: [{ kind: 'sfx', sfx: 'doorOpen' }],
      }
    }

    case 'leave': {
      const a = state.agents.find(x => x.id === action.agentId)
      if (!a || a.state === 'leaving') return { state, effects: [] }
      const out = walkTo({ ...a, state: 'leaving', statusText: 'pulang', assignedSpotId: undefined, needsYou: undefined }, ENTRY, env)
      return { state: replace(state, out, { ...(state.meta[a.id] ?? {}), pending: undefined }), effects: [] }
    }

    case 'status': {
      const s = action.agent
      const a = state.agents.find(x => x.id === s.id)
      if (!a) return reduceOffice(state, { type: 'hire', agent: s }, env)
      if (a.state === 'leaving') return { state, effects: [] }
      const effects: OfficeEffect[] = []
      if (s.work === 'needs_you' && a.needsYou?.approvalId !== s.needsYou?.approvalId) effects.push({ kind: 'sfx', sfx: 'needsYou' })
      if (s.work === 'failed' && !a.lastFailed) effects.push({ kind: 'sfx', sfx: 'error' })

      // Walking in or waiting for a desk: labels now, posture on arrival
      if (a.state === 'new-hire' || a.state === 'waiting' || a.state === 'walking-to-desk') {
        const kept = { ...withLabels(a, s, env.now), state: a.state }
        return { state: replace(state, kept, { ...(state.meta[a.id] ?? {}), pending: s }), effects }
      }
      // On a coffee break and there is work again: back to the desk
      if (a.state === 'coffee-break') {
        if (s.work === 'idle') return { state: replace(state, { ...withLabels(a, s, env.now), state: 'coffee-break', statusText: 'rehat kopi' }), effects }
        const back = walkTo({ ...withLabels(a, s, env.now), state: 'walking-to-desk' }, a.deskPosition, env)
        return { state: replace(state, back, { ...(state.meta[a.id] ?? {}), pending: s, breakUntil: undefined, breakDone: false }), effects }
      }
      return { state: settle(state, a, s, env), effects }
    }

    case 'incident': {
      if (state.incident.active === action.active && state.incident.reason === action.reason) return { state, effects: [] }
      const since = action.active ? (state.incident.active ? state.incident.since : env.now) : null
      return {
        state: { ...state, incident: { active: action.active, reason: action.reason, since } },
        effects: action.active && !state.incident.active ? [{ kind: 'sfx', sfx: 'alarm' }] : [],
      }
    }

    case 'celebrate': {
      const until = env.now + CELEBRATE_MS
      return {
        state: {
          ...state,
          agents: state.agents.map(a => (a.state === 'leaving' ? a : { ...a, scene: { kind: 'shipped', until } })),
        },
        effects: [{ kind: 'sfx', sfx: 'celebration' }],
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Animation frame
// ---------------------------------------------------------------------------

const MOVING = new Set<Agent['state']>(['new-hire', 'walking-to-desk', 'coffee-break', 'leaving', 'waiting'])

/** Advance every walk by `dt` ms; handle arrivals, the end of breaks and scenes. */
export function stepOffice(state: OfficeState, dt: number, env: OfficeEnv): StepResult {
  let cur = state
  let changed = false
  const speed = WALK_SPEED * Math.min(dt, 100) / (1000 / 60)
  const gone: string[] = []

  for (const original of state.agents) {
    let a = cur.agents.find(x => x.id === original.id)!
    if (a.scene && a.scene.until <= env.now) {
      a = { ...a, scene: undefined }
      cur = replace(cur, a)
      changed = true
    }
    if (!MOVING.has(a.state)) continue

    // Walk
    if (!near(a.position, a.targetPosition) || (a.pathQueue?.length ?? 0) > 0) {
      const queue = a.pathQueue ?? []
      const goal = queue.length > 0 ? queue[0] : a.targetPosition
      const step = stepToward(a.position, goal, speed)
      a = { ...a, position: step.position, pathQueue: step.arrived && queue.length > 0 ? queue.slice(1) : queue }
      cur = replace(cur, a)
      changed = true
      if (!(step.arrived && queue.length === 0)) continue
    }

    // Arrived
    const meta = cur.meta[a.id] ?? {}
    switch (a.state) {
      case 'leaving':
        gone.push(a.id)
        break
      case 'new-hire':
      case 'walking-to-desk': {
        if (meta.pending) cur = settle(cur, a, meta.pending, env)
        else cur = replace(cur, { ...a, state: 'idle', spriteFacing: deskFacing(a) })
        changed = true
        break
      }
      case 'coffee-break': {
        if (meta.breakUntil === undefined) {
          cur = replace(cur, a, { ...meta, breakUntil: env.now + BREAK_MS })
          changed = true
        } else if (env.now >= meta.breakUntil) {
          const back = walkTo({ ...a, state: 'walking-to-desk', statusText: 'kembali ke meja' }, a.deskPosition, env)
          const idle: SnapAgent | undefined = meta.pending
          cur = replace(cur, back, { ...meta, breakUntil: undefined, breakDone: true, pending: idle ?? snapFromAgent(a, 'idle') })
          changed = true
        }
        break
      }
      case 'waiting': {
        const desk = freeDesk(cur.agents)
        if (desk) {
          const go = walkTo({ ...a, state: 'new-hire', assignedSpotId: desk.id, deskPosition: { x: desk.x, y: desk.y }, spriteFacing: desk.spriteFacing }, { x: desk.x, y: desk.y }, env)
          cur = replace(cur, go, { ...meta, lobbySlot: undefined })
          changed = true
        }
        break
      }
    }
  }

  if (gone.length > 0) {
    const drop = new Set(gone)
    const meta = { ...cur.meta }
    for (const id of gone) delete meta[id]
    cur = { ...cur, agents: cur.agents.filter(a => !drop.has(a.id)), meta }
    changed = true
  }
  return { state: cur, effects: [], changed }
}

/** A SnapAgent standing for what an agent already shows (used when a break ends). */
function snapFromAgent(a: Agent, work: SnapAgent['work']): SnapAgent {
  return {
    id: a.id, name: a.name, role: a.role, charBase: a.charBase, color: a.color,
    work, statusText: a.statusText ?? '', taskId: a.taskId, taskTitle: a.task, subtaskKey: a.subtaskKey, needsYou: a.needsYou,
  }
}

export { isAtDesk }
