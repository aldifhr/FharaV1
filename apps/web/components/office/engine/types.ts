/*
 * Office model types. Adapted from Claude-Office
 * (https://github.com/W17ant/Claude-Office), src/types.ts.
 * Copyright (c) 2026 W17ANT. MIT License, see /office/LICENSE-claude-office.txt.
 *
 * Fhara port: the Claude Code session / hook fields are gone; a character is
 * one Fhara agent and its state comes from Convex (see ../feed.ts).
 */

export type AgentState =
  | 'new-hire'          // walking in from the door to its desk
  | 'walking-to-desk'   // walking back to the desk (after a break)
  | 'working'           // at the desk on a subtask
  | 'idle'              // at the desk, nothing to do
  | 'coffee-break'      // walking to / standing at the coffee machine
  | 'completed'         // at the desk, just finished a subtask (thumbs up)
  | 'leaving'           // removed from the project: walking out
  | 'waiting'           // no free desk: standing by the door

export interface Position {
  x: number
  y: number
}

export type SpriteFacing = 'front-left' | 'front-right' | 'rear-left' | 'rear-right'

/** Why an agent has its hand up: a pending Fhara approval it asked for. */
export interface NeedsYou {
  approvalId: string
  kind: string
  summary: string
}

/** A short scene drawn over a character (effect sprite). */
export interface AgentScene {
  kind: 'shipped' | 'red' | 'pushed'
  until: number
}

export interface Agent {
  id: string
  name: string
  /** Fhara role key (cto, frontend, …) */
  role: string
  /** Character sprite base in /office/sprites/characters (e.g. "dev-1") */
  charBase: string
  state: AgentState
  position: Position
  targetPosition: Position
  deskPosition: Position
  assignedSpotId?: string
  spriteFacing?: SpriteFacing
  /** Current task title */
  task?: string
  taskId?: string
  /** Current subtask key */
  subtaskKey?: string
  statusText?: string
  color: string
  hiredAt: number
  pathQueue?: Position[]
  lastFailed?: boolean
  needsYou?: NeedsYou
  scene?: AgentScene
}
