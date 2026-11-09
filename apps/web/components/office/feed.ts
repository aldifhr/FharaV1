/**
 * Fhara -> office mapping (pure, no React/Convex imports, unit-tested in
 * tests/unit/officeFeed.test.mjs).
 *
 *   buildOfficeSnapshot(docs)   Convex documents -> what the office should show
 *   diffOfficeSnapshots(a, b)   two snapshots -> the OfficeAction stream the
 *                               reducer (engine/officeReducer.ts) animates
 *
 * Only type imports here so node --test can load the file directly.
 */

import type { CharacterRow } from './characters'
import type { NeedsYou } from './engine/types'

// ---------------------------------------------------------------------------
// Input shapes (the fields we read of each Convex document)
// ---------------------------------------------------------------------------

export interface AgentDoc {
  _id: string
  name: string
  role: string
  status?: string
  isEnabled?: boolean
}

export interface TaskDoc {
  _id: string
  title: string
  status: string
  _creationTime?: number
  updatedAt?: number
  completedAt?: number
  errorMessage?: string
  assignedAgentIds?: string[]
}

export interface SubtaskDoc {
  _id?: string
  taskId: string
  key: string
  title: string
  status: string
  assignedAgentId?: string
  activity?: string
  activityAt?: number
  startedAt?: number
  completedAt?: number
  error?: string
}

export interface ApprovalDoc {
  _id: string
  taskId: string
  kind: string
  summary: string
  status: string
  subtaskKey?: string
  requestedByAgentId?: string
  principalAgentId?: string
  offerAlways?: boolean
  payload?: unknown
  _creationTime?: number
}

export interface PushDoc {
  _id: string
  taskId: string
  status: string
  branchName?: string
  error?: string
  pushedAt?: number
  updatedAt?: number
  prUrl?: string
}

export interface UsageTotals {
  tokens: number
  cost: number | null
  calls: number
  since: number
}

export interface FeedInput {
  agents: AgentDoc[]
  tasks: TaskDoc[]
  subtasks: SubtaskDoc[]
  approvals: ApprovalDoc[]
  pushes: PushDoc[]
  usage?: UsageTotals | null
  characters: CharacterRow[]
  now: number
}

// ---------------------------------------------------------------------------
// Output: the snapshot
// ---------------------------------------------------------------------------

export type WorkState = 'working' | 'idle' | 'completed' | 'failed' | 'needs_you'

export interface SnapAgent {
  id: string
  name: string
  role: string
  charBase: string
  color: string
  work: WorkState
  statusText: string
  taskId?: string
  taskTitle?: string
  subtaskKey?: string
  needsYou?: NeedsYou
}

export type BoardColumn = 'todo' | 'in_progress' | 'done' | 'blocked'

export interface BoardTask {
  id: string
  title: string
  column: BoardColumn
  status: string
}

/** One approval the permission cards show, with the buttons it may offer. */
export interface ApprovalCardModel {
  id: string
  taskId: string
  agentId: string | null
  agentName: string | null
  kind: string
  summary: string
  command: string | null
  /** run_command answers through commandApprovals.respond; everything else through approvals.approve/reject */
  channel: 'command' | 'approval'
  /** "Selalu izinkan" only when the server offered it and the command is not dangerous/push */
  offerAlways: boolean
}

export interface OfficeSnapshot {
  agents: SnapAgent[]
  board: BoardTask[]
  approvals: ApprovalCardModel[]
  incident: { active: boolean; reason: string | null; taskId: string | null }
  /** When the newest failed task or push failed (ms), null if none in view */
  lastIncidentAt: number | null
  /** Push rows that ended pushed, by id (celebrations fire for new ids) */
  pushedIds: string[]
  usage: UsageTotals | null
}

/** A finished subtask keeps its thumbs-up / red bubble this long. */
export const RECENT_MS = 2 * 60_000
/** A failed task or push keeps the office in incident mode this long (unless fixed sooner). */
export const INCIDENT_MS = 30 * 60_000

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

/** Stable 32-bit string hash (djb2 variant). */
export function hashString(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/**
 * Give every agent a character. Role matches first (table order, then
 * fallback roles), then a hash of the agent id over the whole table, probing
 * for a character nobody on screen has. Once every character is in use,
 * characters repeat (the name tag tells them apart). Agents are processed in
 * id order, so the same roster always gets the same characters.
 */
export function assignCharacters(agents: Pick<AgentDoc, '_id' | 'role'>[], table: CharacterRow[]): Map<string, CharacterRow> {
  const out = new Map<string, CharacterRow>()
  if (table.length === 0) return out
  const used = new Set<string>()
  const sorted = [...agents].sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))
  const role = (a: Pick<AgentDoc, 'role'>) => (a.role ?? '').trim().toLowerCase()

  for (const pass of ['roles', 'fallbackRoles'] as const) {
    for (const a of sorted) {
      if (out.has(a._id)) continue
      const row = table.find(r => !used.has(r.base) && (r[pass] ?? []).includes(role(a)))
      if (row) { out.set(a._id, row); used.add(row.base) }
    }
  }
  for (const a of sorted) {
    if (out.has(a._id)) continue
    const start = hashString(a._id) % table.length
    let row = table[start]
    for (let i = 0; i < table.length; i++) {
      const cand = table[(start + i) % table.length]
      if (!used.has(cand.base)) { row = cand; break }
    }
    out.set(a._id, row)
    used.add(row.base)
  }
  return out
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

const RUNNING_SUBTASK = new Set(['running', 'waiting_approval'])
const BUSY_AGENT_STATUS: Record<string, string> = {
  working: 'bekerja…',
  thinking: 'berpikir…',
  reviewing: 'meninjau…',
}

/** Fhara task status -> whiteboard column (null = not drawn). */
export function boardColumn(status: string): BoardColumn | null {
  switch (status) {
    case 'queued':
    case 'paused':
      return 'todo'
    case 'running':
      return 'in_progress'
    case 'done':
      return 'done'
    case 'needs_approval':
    case 'waiting_input':
    case 'failed':
      return 'blocked'
    default:
      return null // rejected, cancelled: off the board
  }
}

function isDangerous(a: ApprovalDoc): boolean {
  const p = (a.payload ?? {}) as { danger?: unknown; command?: unknown }
  if (p.danger) return true
  const cmd = typeof p.command === 'string' ? p.command : ''
  return /\bgit\s+push\b|\bgh\s+pr\s+merge\b|\brm\s+-rf?\b|--force\b/.test(cmd)
}

/** Fhara approval -> the card the office shows. */
export function approvalCard(a: ApprovalDoc, agentId: string | null, agentName: string | null): ApprovalCardModel {
  const p = (a.payload ?? {}) as { command?: unknown }
  const command = typeof p.command === 'string' ? p.command : null
  const channel = a.kind === 'run_command' ? 'command' : 'approval'
  return {
    id: a._id,
    taskId: a.taskId,
    agentId,
    agentName,
    kind: a.kind,
    summary: a.summary,
    command,
    channel,
    // Never for push / merge / destructive, and only when the server offered it
    offerAlways: channel === 'command' && a.offerAlways === true && !isDangerous(a),
  }
}

/** Which agent raises its hand for an approval. */
function approvalOwner(a: ApprovalDoc, subtasks: SubtaskDoc[], tasks: TaskDoc[], agents: AgentDoc[]): string | null {
  const ids = new Set(agents.map(x => x._id))
  for (const id of [a.requestedByAgentId, a.principalAgentId]) if (id && ids.has(id)) return id
  if (a.subtaskKey) {
    const st = subtasks.find(s => s.taskId === a.taskId && s.key === a.subtaskKey)
    if (st?.assignedAgentId && ids.has(st.assignedAgentId)) return st.assignedAgentId
  }
  const running = subtasks.find(s => s.taskId === a.taskId && RUNNING_SUBTASK.has(s.status) && s.assignedAgentId && ids.has(s.assignedAgentId))
  if (running?.assignedAgentId) return running.assignedAgentId
  const task = tasks.find(t => t._id === a.taskId)
  const assigned = task?.assignedAgentIds?.find(id => ids.has(id))
  if (assigned) return assigned
  // Plans and pushes nobody asked for by name go to the CTO's desk
  return agents.find(x => x.role === 'cto')?._id ?? agents[0]?._id ?? null
}

function latest<T>(rows: T[], at: (r: T) => number): T | undefined {
  let best: T | undefined
  for (const r of rows) if (!best || at(r) > at(best)) best = r
  return best
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export function buildOfficeSnapshot(input: FeedInput): OfficeSnapshot {
  const { now } = input
  const agents = input.agents.filter(a => a.isEnabled !== false)
  const chars = assignCharacters(agents, input.characters)
  const taskById = new Map(input.tasks.map(t => [t._id, t]))
  const pending = input.approvals.filter(a => a.status === 'pending')

  const cards: ApprovalCardModel[] = []
  const handUp = new Map<string, NeedsYou>()
  for (const a of pending) {
    const owner = approvalOwner(a, input.subtasks, input.tasks, agents)
    const name = owner ? agents.find(x => x._id === owner)?.name ?? null : null
    cards.push(approvalCard(a, owner, name))
    if (owner && !handUp.has(owner)) handUp.set(owner, { approvalId: a._id, kind: a.kind, summary: a.summary })
  }

  const snapAgents: SnapAgent[] = agents.map(a => {
    const row = chars.get(a._id)
    const base: SnapAgent = {
      id: a._id,
      name: a.name,
      role: a.role,
      charBase: row?.base ?? 'employee-3',
      color: row?.color ?? '#95a5a6',
      work: 'idle',
      statusText: 'rehat kopi',
    }
    const mine = input.subtasks.filter(s => s.assignedAgentId === a._id)
    const running = latest(mine.filter(s => RUNNING_SUBTASK.has(s.status)), s => s.activityAt ?? s.startedAt ?? 0)
    const finished = latest(
      mine.filter(s => (s.status === 'completed' || s.status === 'failed') && s.completedAt !== undefined && now - s.completedAt < RECENT_MS),
      s => s.completedAt ?? 0,
    )
    const pick = running ?? finished
    const task = pick ? taskById.get(pick.taskId) : undefined
    const withTask = pick
      ? { ...base, taskId: pick.taskId, taskTitle: task?.title, subtaskKey: pick.key }
      : base

    const hand = handUp.get(a._id)
    if (hand) {
      return { ...withTask, taskId: withTask.taskId ?? pending.find(p => p._id === hand.approvalId)?.taskId, work: 'needs_you', statusText: hand.summary, needsYou: hand }
    }
    if (running) return { ...withTask, work: 'working', statusText: running.activity?.trim() || running.title }
    if (finished?.status === 'failed') return { ...withTask, work: 'failed', statusText: finished.error?.trim() || `gagal: ${finished.title}` }
    if (finished) return { ...withTask, work: 'completed', statusText: `selesai: ${finished.title}` }
    const busy = a.status ? BUSY_AGENT_STATUS[a.status] : undefined
    if (busy) return { ...base, work: 'working', statusText: busy }
    return base
  })

  // Whiteboard: newest first, terminal tasks capped so the board stays readable
  const board: BoardTask[] = []
  for (const t of [...input.tasks].sort((x, y) => (y.updatedAt ?? y._creationTime ?? 0) - (x.updatedAt ?? x._creationTime ?? 0))) {
    const column = boardColumn(t.status)
    if (!column) continue
    board.push({ id: t._id, title: t.title, column, status: t.status })
  }

  // Incident: the newest finished task failed, or the newest push failed, recently
  let incident: OfficeSnapshot['incident'] = { active: false, reason: null, taskId: null }
  const terminal = input.tasks.filter(t => t.status === 'done' || t.status === 'failed')
  const lastTask = latest(terminal, t => t.completedAt ?? t.updatedAt ?? 0)
  if (lastTask?.status === 'failed' && now - (lastTask.completedAt ?? lastTask.updatedAt ?? 0) < INCIDENT_MS) {
    incident = { active: true, reason: `Task gagal: ${lastTask.title}`, taskId: lastTask._id }
  }
  const lastPush = latest(input.pushes.filter(p => p.status === 'pushed' || p.status === 'failed'), p => p.updatedAt ?? p.pushedAt ?? 0)
  if (lastPush?.status === 'failed' && now - (lastPush.updatedAt ?? 0) < INCIDENT_MS) {
    incident = { active: true, reason: `Push gagal${lastPush.branchName ? ` (${lastPush.branchName})` : ''}`, taskId: lastPush.taskId }
  }

  const failedAt = [
    ...input.tasks.filter(t => t.status === 'failed').map(t => t.completedAt ?? t.updatedAt ?? 0),
    ...input.pushes.filter(p => p.status === 'failed').map(p => p.updatedAt ?? 0),
  ].filter(n => n > 0)

  return {
    agents: snapAgents,
    lastIncidentAt: failedAt.length ? Math.max(...failedAt) : null,
    board,
    approvals: cards,
    incident,
    pushedIds: input.pushes.filter(p => p.status === 'pushed').map(p => p._id).sort(),
    usage: input.usage && input.usage.calls > 0 ? input.usage : null,
  }
}

// ---------------------------------------------------------------------------
// Diff -> actions
// ---------------------------------------------------------------------------

export type OfficeAction =
  /** A character for this agent walks in (initial work state applied on arrival) */
  | { type: 'hire'; agent: SnapAgent }
  /** The agent left the project: walks out */
  | { type: 'leave'; agentId: string }
  /** The agent's work changed (working / idle / completed / failed / needs_you) */
  | { type: 'status'; agent: SnapAgent }
  | { type: 'incident'; active: boolean; reason: string | null }
  /** A push landed: party bubbles + celebration sound */
  | { type: 'celebrate'; pushId: string }

function sameAgent(a: SnapAgent, b: SnapAgent): boolean {
  return a.work === b.work && a.statusText === b.statusText && a.taskId === b.taskId &&
    a.subtaskKey === b.subtaskKey && a.needsYou?.approvalId === b.needsYou?.approvalId &&
    a.name === b.name && a.charBase === b.charBase
}

/**
 * The actions that take the office from `prev` to `next`. With no `prev`
 * (first load) every agent is hired in its current state, the incident flag
 * is set as it stands and no old push is celebrated.
 */
export function diffOfficeSnapshots(prev: OfficeSnapshot | null, next: OfficeSnapshot): OfficeAction[] {
  const out: OfficeAction[] = []
  const before = new Map((prev?.agents ?? []).map(a => [a.id, a]))
  const nextIds = new Set(next.agents.map(a => a.id))

  for (const a of prev?.agents ?? []) if (!nextIds.has(a.id)) out.push({ type: 'leave', agentId: a.id })
  for (const a of next.agents) {
    const old = before.get(a.id)
    if (!old) out.push({ type: 'hire', agent: a })
    else if (!sameAgent(old, a)) out.push({ type: 'status', agent: a })
  }

  if (!prev || prev.incident.active !== next.incident.active || prev.incident.reason !== next.incident.reason) {
    if (prev || next.incident.active) out.push({ type: 'incident', active: next.incident.active, reason: next.incident.reason })
  }

  if (prev) {
    const seen = new Set(prev.pushedIds)
    for (const id of next.pushedIds) if (!seen.has(id)) out.push({ type: 'celebrate', pushId: id })
  }
  return out
}
