/*
 * Movement, waypoint pathfinding and effect sprites. Adapted from Claude-Office
 * (https://github.com/W17ant/Claude-Office), src/agentManager.ts.
 * Copyright (c) 2026 W17ANT. MIT License, see /office/LICENSE-claude-office.txt.
 *
 * Fhara port: no theme/skin hooks; randomness is injected so the reducer
 * stays deterministic under test.
 */

import type { AgentState, Position } from './types'
import type { Waypoint } from './rooms'

export const FX = '/office/sprites/effects'

/** Walking speed in %-units per frame at 60fps */
export const WALK_SPEED = 0.08

export function stepToward(position: Position, target: Position, speed: number): { position: Position; arrived: boolean } {
  const dx = target.x - position.x
  const dy = target.y - position.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist <= speed) return { position: { ...target }, arrived: true }
  return { position: { x: position.x + (dx / dist) * speed, y: position.y + (dy / dist) * speed }, arrived: false }
}

function nearestWaypoint(x: number, y: number, waypoints: Waypoint[]): Waypoint {
  let best = waypoints[0]
  let bestDist = Infinity
  for (const wp of waypoints) {
    const d = (wp.x - x) ** 2 + (wp.y - y) ** 2
    if (d < bestDist) { bestDist = d; best = wp }
  }
  return best
}

function bfsWaypoints(startId: string, endId: string, waypoints: Waypoint[]): string[] | null {
  if (startId === endId) return [startId]
  const byId = new Map(waypoints.map(w => [w.id, w]))
  const visited = new Set<string>([startId])
  const queue: { id: string; path: string[] }[] = [{ id: startId, path: [startId] }]
  while (queue.length > 0) {
    const { id, path } = queue.shift()!
    const node = byId.get(id)
    if (!node) continue
    for (const n of node.connections) {
      if (n === endId) return [...path, endId]
      if (!visited.has(n)) { visited.add(n); queue.push({ id: n, path: [...path, n] }) }
    }
  }
  return null
}

/**
 * Waypoints to walk through from (from) to (to); the caller keeps walking to
 * its target once the queue is empty. Slight jitter so agents don't share a line.
 */
export function findWaypointPath(from: Position, to: Position, waypoints: Waypoint[], random: () => number = Math.random): Position[] {
  if (waypoints.length === 0) return []
  const start = nearestWaypoint(from.x, from.y, waypoints)
  const end = nearestWaypoint(to.x, to.y, waypoints)
  const ids = bfsWaypoints(start.id, end.id, waypoints)
  if (!ids) return [{ x: start.x, y: start.y }]
  const byId = new Map(waypoints.map(w => [w.id, w]))
  const jitter = (v: number) => v + (random() - 0.5) * 3
  return ids.map(id => {
    const wp = byId.get(id)!
    return { x: jitter(wp.x), y: jitter(wp.y) }
  })
}

/** The effect sprite above a character for its state (or null). */
export function getEffect(state: AgentState, statusText?: string, lastFailed?: boolean, incident?: boolean): string | null {
  if (lastFailed && incident) return `${FX}/build-failed.png`
  switch (state) {
    case 'working': {
      const text = (statusText ?? '').toLowerCase()
      if (text.includes('test')) return `${FX}/typing.png`
      return null
    }
    case 'coffee-break': return `${FX}/need-coffee.png`
    case 'new-hire': return `${FX}/star.png`
    case 'completed': return `${FX}/thumb-up.png`
    case 'idle': return `${FX}/sleeping.png`
    default: return null
  }
}
