"use client";
/*
 * The kanban whiteboard on the office wall. Adapted from Claude-Office
 * (https://github.com/W17ant/Claude-Office), src/components/TaskBoard.tsx
 * and src/taskBoard.ts (board geometry measured from the room art).
 * Copyright (c) 2026 W17ANT. MIT License, see /office/LICENSE-claude-office.txt.
 *
 * Fhara port: the notes are the project's tasks, in four columns
 * (To do / In progress / Done / Blocked).
 */
import React, { useState } from 'react'
import type { BoardColumn, BoardTask } from '../feed'

/** Where the board's writing surface sits in the room art, in % of the room. */
export const BOARD_RECT = Object.freeze({ left: 74.85, top: 26.1, width: 10.6, height: 9.9, skewDeg: 23.1 })

const COLUMNS: ReadonlyArray<{ column: BoardColumn; title: string; width: number; note: string }> = [
  { column: 'todo', title: 'To do', width: 24, note: 'pending' },
  { column: 'in_progress', title: 'In progress', width: 28, note: 'in_progress' },
  { column: 'done', title: 'Done', width: 24, note: 'completed' },
  { column: 'blocked', title: 'Blocked', width: 24, note: 'blocked_col' },
]
const COLUMN_MAX = 6

const STATUS_LABEL: Record<string, string> = {
  queued: 'antri',
  paused: 'dijeda',
  running: 'berjalan',
  done: 'selesai',
  needs_approval: 'menunggu persetujuan',
  waiting_input: 'menunggu jawaban',
  failed: 'gagal',
}

interface TaskBoardProps {
  tasks: BoardTask[]
  /** 0 day … 1 night: the board dims with the room */
  night: number
  onOpen?: (taskId: string) => void
}

const TaskBoard: React.FC<TaskBoardProps> = ({ tasks, night, onOpen }) => {
  const [hovered, setHovered] = useState<BoardTask | null>(null)
  if (tasks.length === 0) return null
  const counts = Object.fromEntries(COLUMNS.map(c => [c.column, tasks.filter(t => t.column === c.column).length]))

  return (
    <>
      <div
        className="task-board"
        style={{
          left: `${BOARD_RECT.left}%`,
          top: `${BOARD_RECT.top}%`,
          width: `${BOARD_RECT.width}%`,
          height: `${BOARD_RECT.height}%`,
          transform: `skewY(${BOARD_RECT.skewDeg}deg)`,
        }}
        aria-label={`Papan tugas: ${counts.todo} to do, ${counts.in_progress} in progress, ${counts.done} done, ${counts.blocked} blocked`}
        title="Papan tugas"
      >
        <div className="task-board-surface" />
        <div className="task-board-columns">
          {COLUMNS.map(col => {
            const all = tasks.filter(t => t.column === col.column)
            const shown = all.length > COLUMN_MAX ? all.slice(0, COLUMN_MAX - 1) : all
            const more = all.length - shown.length
            return (
              <div key={col.column} className="task-col" style={{ width: `${col.width}%` }}>
                <div className="task-col-title">{col.title}</div>
                <div className="task-col-notes">
                  {shown.map(task => (
                    <span
                      key={task.id}
                      className={`task-note ${col.note}`}
                      aria-label={task.title}
                      role={onOpen ? 'button' : undefined}
                      onMouseEnter={() => setHovered(task)}
                      onMouseLeave={() => setHovered(null)}
                      onClick={onOpen ? (e) => { e.stopPropagation(); onOpen(task.id) } : undefined}
                    />
                  ))}
                  {more > 0 && <span className="task-more" aria-label={`${more} lagi`}>+{more}</span>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="task-board-night" style={{ opacity: Math.max(0, Math.min(1, night)) }} aria-hidden="true" />
      </div>

      {hovered && (
        <div
          className={`task-board-caption ${hovered.column === 'done' ? 'completed' : hovered.column === 'in_progress' ? 'in_progress' : ''}`}
          style={{ left: `${BOARD_RECT.left}%`, top: `${BOARD_RECT.top - 0.8}%` }}
          role="tooltip"
        >
          {hovered.title} · {STATUS_LABEL[hovered.status] ?? hovered.status}
        </div>
      )}
    </>
  )
}

export default TaskBoard
