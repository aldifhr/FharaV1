/**
 * The office character table: every walking character the office can draw,
 * and which Fhara roles prefer which character.
 *
 * Adding a character needs no code change elsewhere: draw it in the
 * public/office/sprites/characters/TEMPLATE.png layout, export the four
 * facings as `<base>-front-left.png`, `<base>-front-right.png`,
 * `<base>-rear-left.png`, `<base>-rear-right.png` into
 * apps/web/public/office/sprites/characters/, then add a row below.
 *
 * Rows with source 'claude-office' are Claude-Office sprites
 * (https://github.com/W17ant/Claude-Office), Copyright (c) 2026 W17ANT, MIT
 * License (see /office/LICENSE-claude-office.txt). Rows with source 'fhara'
 * (Designer-1, Researcher-1, Data-scientist-1, Support-1) are original Fhara
 * art made for this project and are not covered by that notice.
 */

export interface CharacterRow {
  /** File base name in /office/sprites/characters (four facings must exist) */
  base: string
  /** Roles that should get this character first (Fhara role keys) */
  roles: string[]
  /** Roles that take this character only when their first choice is taken */
  fallbackRoles?: string[]
  /** Name-tag colour */
  color: string
  /** Where the art comes from (attribution; see THIRD_PARTY_NOTICES.md) */
  source: 'claude-office' | 'fhara'
}

/**
 * Order matters twice: role matches are tried top to bottom, and agents
 * without a role match get a character by hash of their id over this list.
 */
export const CHARACTER_TABLE: CharacterRow[] = [
  { base: 'Me-1',             roles: ['cto', 'lead'],              color: '#ff4444', source: 'claude-office' },
  { base: 'Designer-1',       roles: ['designer', 'ui-ux'],        color: '#e91e63', source: 'fhara' },
  { base: 'Researcher-1',     roles: ['researcher'],               color: '#4caf50', source: 'fhara' },
  { base: 'Data-scientist-1', roles: ['data-scientist', 'product-analyst'], color: '#795548', source: 'fhara' },
  { base: 'Support-1',        roles: ['support'], fallbackRoles: ['growth'], color: '#00acc1', source: 'fhara' },
  { base: 'Frontend-dev-1',   roles: ['frontend'],                 color: '#2ecc71', source: 'claude-office' },
  { base: 'dev-2',            roles: ['backend', 'fullstack'],     color: '#9b59b6', source: 'claude-office' },
  { base: 'employee-2',       roles: ['qa', 'tester'],             color: '#f39c12', source: 'claude-office' },
  { base: 'employee-1',       roles: ['reviewer'],                 color: '#3498db', source: 'claude-office' },
  { base: 'employee-3',       roles: ['devops'],                   color: '#607d8b', source: 'claude-office' },
  { base: 'security-audit-1', roles: ['security'],                 color: '#e67e22', source: 'claude-office' },
  { base: 'explore-1',        roles: ['explorer'], fallbackRoles: ['researcher'], color: '#8bc34a', source: 'claude-office' },
  { base: 'Claude-1',         roles: ['assistant'], fallbackRoles: ['growth'], color: '#cc785c', source: 'claude-office' },
  { base: 'dev-1',            roles: ['debugger'], fallbackRoles: ['backend'], color: '#e74c3c', source: 'claude-office' },
]

/** Folder the four-facing character sprites live in (public URL). */
export const CHARACTER_DIR = '/office/sprites/characters'

/**
 * Single-pose role portraits (Claude-Office's role sprites), shown in the
 * inspector card. Role key -> file in /office/sprites; unknown roles fall
 * back to `default`.
 */
export const ROLE_PORTRAITS: Record<string, string> = {
  cto: 'manager.png',
  lead: 'manager.png',
  frontend: 'frontend.png',
  designer: 'frontend.png',
  backend: 'fullstack.png',
  fullstack: 'fullstack.png',
  reviewer: 'reviewer.png',
  security: 'security.png',
  qa: 'tester.png',
  tester: 'tester.png',
  devops: 'devops.png',
  debugger: 'debugger.png',
  researcher: 'debugger.png',
  support: 'reviewer.png',
  default: 'fullstack.png',
}

export const PORTRAIT_DIR = '/office/sprites'
