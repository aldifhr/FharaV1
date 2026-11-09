"use client";
/*
 * One office character. Adapted from Claude-Office
 * (https://github.com/W17ant/Claude-Office), src/components/Character.tsx.
 * Copyright (c) 2026 W17ANT. MIT License, see /office/LICENSE-claude-office.txt.
 *
 * Fhara port: the sprite base comes from the character table (characters.ts),
 * the name tag is always shown (characters repeat once there are more agents
 * than sprites), and the hand-up badge is a pending Fhara approval.
 */
import React, { useEffect, useRef, useState } from 'react'
import type { Agent, AgentState, SpriteFacing } from '../engine/types'
import { FX, getEffect } from '../engine/pathing'
import { CHARACTER_DIR } from '../characters'
import ResilientImg from './ResilientImg'
import EffectBubble from './EffectBubble'
import SpeechBubble from './SpeechBubble'

interface CharacterProps {
  agent: Agent
  /** ms the agent has been idle at its desk (sleeping bubble after 30 s) */
  idleMs?: number
  zIndex?: number
  incident?: boolean
  onClick?: (agentId: string) => void
  inspected?: boolean
}

function directionFromDelta(dx: number, dy: number): SpriteFacing {
  if (dy < 0 && dx >= 0) return 'front-left'
  if (dy < 0 && dx < 0) return 'front-right'
  if (dy >= 0 && dx >= 0) return 'rear-left'
  return 'front-left'
}

function animState(state: AgentState): string {
  switch (state) {
    case 'working': return 'working'
    case 'new-hire': return 'new-hire'
    case 'walking-to-desk':
    case 'leaving': return 'walking'
    case 'coffee-break': return 'coffee'
    default: return 'idle'
  }
}

const SCENE_SPRITES: Record<NonNullable<Agent['scene']>['kind'], string> = {
  shipped: `${FX}/party.png`,
  red: `${FX}/build-failed.png`,
  pushed: `${FX}/github-pr-merge.png`,
}

const OPPOSITE: Record<SpriteFacing, SpriteFacing> = {
  'front-left': 'rear-right',
  'front-right': 'rear-left',
  'rear-left': 'front-right',
  'rear-right': 'front-left',
}

const BUBBLE_MS = 3200

const Character: React.FC<CharacterProps> = ({ agent, idleMs = 0, zIndex, incident, onClick, inspected }) => {
  const prevPos = useRef({ x: agent.position.x, y: agent.position.y })
  const direction = useRef<SpriteFacing>(agent.spriteFacing ?? 'front-right')
  const [turned, setTurned] = useState(false)

  const moving = agent.state === 'new-hire' || agent.state === 'walking-to-desk' || agent.state === 'coffee-break' || agent.state === 'leaving' || agent.state === 'waiting'
  const dx = agent.position.x - prevPos.current.x
  const dy = agent.position.y - prevPos.current.y
  if (moving && (Math.abs(dx) > 0.005 || Math.abs(dy) > 0.005)) {
    direction.current = directionFromDelta(dx, dy)
  } else if (!moving && agent.spriteFacing) {
    direction.current = turned ? OPPOSITE[agent.spriteFacing] : agent.spriteFacing
  }
  prevPos.current = { x: agent.position.x, y: agent.position.y }

  // Now and then a worker turns round at the desk
  useEffect(() => {
    if (agent.state !== 'working') { setTurned(false); return }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      if (cancelled) return
      timer = setTimeout(() => {
        if (cancelled) return
        setTurned(t => !t)
        timer = setTimeout(() => { if (!cancelled) { setTurned(t => !t); schedule() } }, 1000 + Math.random() * 5000)
      }, 3000 + Math.random() * 12000)
    }
    schedule()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [agent.state])

  // A new status line pops a speech bubble for a moment
  const [bubble, setBubble] = useState<string | null>(null)
  const lastStatus = useRef(agent.statusText)
  useEffect(() => {
    if (agent.statusText && agent.statusText !== lastStatus.current && agent.state === 'working') setBubble(agent.statusText)
    lastStatus.current = agent.statusText
  }, [agent.statusText, agent.state])
  useEffect(() => {
    if (!bubble) return
    const t = setTimeout(() => setBubble(null), BUBBLE_MS)
    return () => clearTimeout(t)
  }, [bubble])

  const spriteSrc = `${CHARACTER_DIR}/${agent.charBase}-${direction.current}.png`
  const scene = agent.scene
  let effectSrc: string | null = null
  if (!agent.needsYou) {
    if (scene) effectSrc = SCENE_SPRITES[scene.kind]
    else if (agent.state === 'idle') effectSrc = idleMs > 30_000 ? `${FX}/sleeping.png` : null
    else effectSrc = getEffect(agent.state, agent.statusText, agent.lastFailed, incident)
  }

  const tooltip = [agent.name, agent.statusText].filter(Boolean).join(' — ')

  return (
    <div
      className={`character-wrapper state-${animState(agent.state)}${agent.needsYou ? ' main-needs-you' : ''}${scene ? ` scene-${scene.kind}` : ''}${onClick ? ' clickable' : ''}${inspected ? ' inspected' : ''}`}
      style={{
        left: `${agent.position.x}%`,
        top: `${agent.position.y}%`,
        transform: 'translate(-50%, -100%)',
        zIndex: bubble ? 99 : zIndex ?? Math.round(agent.position.y),
      }}
      title={tooltip}
    >
      {effectSrc && <EffectBubble src={effectSrc} alt={agent.state} />}
      {agent.needsYou && (
        <div className="effect-bubble effect-emoji needs-you" role="img" aria-label="Menunggu persetujuan">✋</div>
      )}
      {agent.needsYou ? (
        <div className="char-needs-you hard">butuh kamu · {agent.name}</div>
      ) : (
        <div className="char-project">{agent.name}</div>
      )}
      {agent.state === 'waiting' && <div className="char-waiting">menunggu meja</div>}
      {bubble && <SpeechBubble key={bubble} text={bubble} duration={BUBBLE_MS} />}

      <div
        className="char-body-group"
        onClick={onClick ? () => onClick(agent.id) : undefined}
        role={onClick ? 'button' : undefined}
        aria-label={onClick ? `Lihat ${agent.name}` : undefined}
        aria-pressed={onClick ? !!inspected : undefined}
        data-agent-id={agent.id}
      >
        <div className="char-shadow" />
        <ResilientImg
          src={spriteSrc}
          alt={agent.name}
          className="char-sprite"
          style={{
            height: agent.role === 'cto' ? 85 : 78,
            width: 'auto',
            filter: `drop-shadow(0 0 1px ${agent.color}) drop-shadow(0 0 0.5px #000)`,
            animationDelay: `${(agent.id.charCodeAt(agent.id.length - 1) * 0.37) % 3}s`,
          }}
          draggable={false}
        />
      </div>
    </div>
  )
}

export default React.memo(Character)
