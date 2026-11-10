// Adapted from threadbear (https://github.com/mikecann/threadbear), runner/src/adapters/acp/normalize.ts
// and runner/src/adapters/context.ts @ 43fa197.
// MIT License, Copyright (c) 2026 Mike Cann. See THIRD_PARTY_NOTICES.md.
//
// Changes for Fhara: the event and output types are local (Fhara stores
// these as taskEvents payloads); images are not saved (a tool's image
// output is dropped, its text kept); big output is cut to 64 KB here and
// the backend moves anything over 2 KB to eventBodies; safe-cut's
// secret-aware first line is a plain first line (Fhara redacts on its own
// path); the threadbear MCP tool-name mapping is dropped. The normalising
// logic (chunks, tool rows, diffs, results, closeOpen) is unchanged.

// Turns ACP's session/update notifications into thread events. Pure apart
// from NormalizerContext, so recorded agent output can be fed straight
// through it in tests.
import crypto from 'node:crypto';
import path from 'node:path';
import { diffLines, type Hunk } from '../diff';

export type ToolKind = 'command' | 'read' | 'edit' | 'search' | 'web' | 'mcp' | 'other';

/** Persisted events (threadbear protocol names) this normaliser produces. */
export type NormalizedEvent =
  | { type: 'assistant.text'; itemId: string; text: string }
  | { type: 'reasoning'; itemId: string; text: string }
  | { type: 'tool.call'; itemId: string; name: string; kind: ToolKind; title: string; input: Record<string, unknown> }
  | { type: 'tool.result'; itemId: string; ok: boolean; text: string; truncated: boolean }
  | { type: 'edit.diff'; itemId: string; path: string; hunks: Hunk[] }
  | { type: 'system.note'; text: string }
  | { type: 'plan.updated'; entries: { text: string; status: 'pending' | 'in_progress' | 'completed' }[] };

/** Transient deltas: never persisted, flushed to hot rows. */
export type NormalizedDelta = { type: 'assistant.text.delta' | 'reasoning.delta'; itemId: string; text: string };

export type AcpOutput =
  | { kind: 'event'; event: NormalizedEvent }
  | { kind: 'delta'; delta: NormalizedDelta }
  | { kind: 'context'; contextTokens: number; contextWindow?: number };

export type NormalizerContext = { cwd: string };

/** Longest tool result text kept on the event (threadbear LIMITS.toolResultText). */
export const TOOL_RESULT_TEXT_MAX = 64 * 1024;
/** Longest string in a tool's input (threadbear LIMITS.toolInputString). */
export const TOOL_INPUT_STRING_MAX = 16 * 1024;

export type AcpToolCall = {
  toolCallId?: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: string;
  locations?: { path?: string }[];
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: AcpToolContent[];
};

type AcpBlock = { type?: string; text?: string; data?: string; mimeType?: string };
type AcpToolContent = { type?: string; content?: AcpBlock; path?: string; newText?: string; oldText?: string | null };

type Tool = {
  id: string;
  emitted: boolean;
  done: boolean;
  acpKind?: string;
  name?: string;
  title?: string;
  input: Record<string, unknown>;
  paths: string[];
  output: AcpToolContent[];
  rawOutput?: unknown;
  diffed: Set<string>;
};

function toolKind(acp: string | undefined): ToolKind {
  switch (acp) {
    case 'read':
      return 'read';
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit';
    case 'search':
      return 'search';
    case 'execute':
      return 'command';
    case 'fetch':
      return 'web';
    default:
      return 'other';
  }
}

// Every file a permission request names, from what the agent says it touches
// and from the tool's own arguments, as one could say less than the other.
// A check takes all of them: more names only makes it stricter.
const PATH_KEY = /path|file|dest|target|document|^to$|^from$/i;
// The files a patch body names: unified diffs and the `*** Update File:` kind.
const PATCH_HEADER = /^(?:\*\*\* (?:Add|Update|Delete) File: |\*\*\* Move to: |\+\+\+ |--- |Index: )(.+)$/gm;

function pathsIn(v: unknown, key: string, out: Set<string>, depth: number): void {
  if (depth > 8) return;
  if (typeof v === 'string') {
    if (v && PATH_KEY.test(key)) out.add(v);
    if (v.includes('\n')) {
      for (const m of v.matchAll(PATCH_HEADER)) {
        const p = m[1].trim().replace(/^[ab]\//, '').split('\t')[0];
        if (p && p !== '/dev/null') out.add(p);
      }
    }
  } else if (Array.isArray(v)) {
    for (const x of v) pathsIn(x, key, out, depth + 1);
  } else if (isPlainObject(v)) {
    for (const [k, x] of Object.entries(v)) pathsIn(x, k, out, depth + 1);
  }
}

export function requestPaths(call: AcpToolCall): string[] {
  const out = new Set<string>();
  for (const l of Array.isArray(call.locations) ? call.locations : []) if (typeof l?.path === 'string' && l.path) out.add(l.path);
  for (const c of Array.isArray(call.content) ? call.content : []) if (c?.type === 'diff' && typeof c.path === 'string' && c.path) out.add(c.path);
  pathsIn(call.rawInput, '', out, 0);
  return [...out];
}

// The arguments of the plain file tools the agents have, where what's named
// is all there is. Any other shape might write somewhere nobody has found:
// such a call can't be covered by "Always allow".
const PLAIN_EDIT_KEYS = new Set(['filepath', 'file_path', 'path', 'content', 'oldstring', 'newstring', 'old_string', 'new_string', 'diff', 'replaceall', 'replace_all', 'description']);

export function isPlainEdit(input: Record<string, unknown>): boolean {
  return Object.entries(input).every(([k, v]) => PLAIN_EDIT_KEYS.has(k.toLowerCase()) && (typeof v === 'string' || typeof v === 'boolean'));
}

// Kinds whose paths say what a call will change.
export function writesFiles(kind: string | undefined): boolean {
  return kind === 'edit' || kind === 'delete' || kind === 'move';
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** The first non-empty line, cut to `max` characters. */
export function firstLine(s: string, max = 200, mark = '…'): string {
  const line = (s.split('\n').find((l) => l.trim()) ?? '').trim();
  return line.length > max ? line.slice(0, max) + mark : line;
}

/** Path relative to the thread's folder when it is inside it. */
export function displayPath(p: string, cwd: string): string {
  if (!p) return '';
  if (!path.isAbsolute(p)) return p;
  const rel = path.relative(cwd, p);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return p;
}

/** Strings in a tool's input cut to 16 KB each. */
export function truncateInput(input: unknown): Record<string, unknown> {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return v.length > TOOL_INPUT_STRING_MAX ? v.slice(0, TOOL_INPUT_STRING_MAX) + '\n[truncated]' : v;
    if (depth > 8 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, depth + 1);
    return out;
  };
  const r = walk(input ?? {}, 0);
  return r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : { value: r };
}

// A tool result's text cut to 64 KB without splitting a UTF-8 character.
export function truncateResultText(text: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= TOOL_RESULT_TEXT_MAX) return { text, truncated: false };
  let end = TOOL_RESULT_TEXT_MAX;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

export class AcpNormalizer {
  private ctx: NormalizerContext;
  private tools = new Map<string, Tool>();
  private text?: { messageId?: string; itemId: string; text: string };
  private thought?: { messageId?: string; itemId: string; text: string };
  private lastAssistant = '';
  costUsd?: number;

  constructor(ctx: NormalizerContext, private readonly newId: () => string = () => crypto.randomUUID()) {
    this.ctx = ctx;
  }

  // The last reply's words.
  takeLastAssistantText(): string {
    const t = this.lastAssistant;
    this.lastAssistant = '';
    return t;
  }

  handle(update: unknown): AcpOutput[] {
    if (!isPlainObject(update)) return [];
    const out: AcpOutput[] = [];
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.chunk(update, 'text', out);
        break;
      case 'agent_thought_chunk':
        this.chunk(update, 'thought', out);
        break;
      case 'tool_call':
      case 'tool_call_update':
        this.flush(out);
        this.toolUpdate(update as AcpToolCall, out);
        break;
      case 'plan':
        this.flush(out);
        if (Array.isArray(update.entries)) out.push({ kind: 'event', event: { type: 'plan.updated', entries: planEntries(update.entries) } });
        break;
      case 'usage_update':
        if (typeof update.used === 'number') out.push({ kind: 'context', contextTokens: update.used, ...(typeof update.size === 'number' ? { contextWindow: update.size } : {}) });
        if (isPlainObject(update.cost) && update.cost.currency === 'USD' && typeof update.cost.amount === 'number') this.costUsd = update.cost.amount;
        break;
      // user_message_chunk, modes, commands and anything newer: nothing to show.
    }
    return out;
  }

  private chunk(update: Record<string, unknown>, which: 'text' | 'thought', out: AcpOutput[]): void {
    const block = (isPlainObject(update.content) ? update.content : {}) as AcpBlock;
    if (block.type !== 'text' || typeof block.text !== 'string' || !block.text) return;
    const messageId = typeof update.messageId === 'string' ? update.messageId : undefined;
    const open = which === 'text' ? this.text : this.thought;
    if (which === 'text') this.flushThought(out);
    else this.flushText(out);
    let current = open;
    if (!current || (messageId && current.messageId && current.messageId !== messageId)) {
      if (which === 'text') this.flushText(out);
      else this.flushThought(out);
      current = { messageId, itemId: this.newId(), text: '' };
      if (which === 'text') this.text = current;
      else this.thought = current;
    }
    current.text += block.text;
    out.push({ kind: 'delta', delta: { type: which === 'text' ? 'assistant.text.delta' : 'reasoning.delta', itemId: current.itemId, text: block.text } });
  }

  private flushText(out: AcpOutput[]): void {
    const t = this.text;
    this.text = undefined;
    if (!t?.text) return;
    this.lastAssistant = t.text;
    out.push({ kind: 'event', event: { type: 'assistant.text', itemId: t.itemId, text: t.text } });
  }

  private flushThought(out: AcpOutput[]): void {
    const t = this.thought;
    this.thought = undefined;
    if (t?.text) out.push({ kind: 'event', event: { type: 'reasoning', itemId: t.itemId, text: t.text } });
  }

  // Closes what's being written, before a tool row or the end of a turn.
  flush(out: AcpOutput[] = []): AcpOutput[] {
    this.flushThought(out);
    this.flushText(out);
    return out;
  }

  private tool(id: string): Tool {
    let t = this.tools.get(id);
    if (!t) {
      t = { id, emitted: false, done: false, input: {}, paths: [], output: [], diffed: new Set() };
      this.tools.set(id, t);
      if (this.tools.size > 500) this.tools.delete(this.tools.keys().next().value!);
    }
    return t;
  }

  private merge(t: Tool, u: AcpToolCall): void {
    if (typeof u.kind === 'string') t.acpKind = u.kind;
    if (typeof u.name === 'string' && u.name) t.name = u.name;
    if (typeof u.title === 'string' && u.title) t.title = u.title;
    if (isPlainObject(u.rawInput) && Object.keys(u.rawInput).length) t.input = u.rawInput;
    // Everything this call has ever named, however it was named.
    for (const p of requestPaths(u)) if (!t.paths.includes(p)) t.paths.push(p);
    if (Array.isArray(u.content)) t.output = u.content;
    if (u.rawOutput !== undefined) t.rawOutput = u.rawOutput;
  }

  // A permission request carries the call as the agent sees it then: a row
  // for it comes before the card, which names the row.
  noteCall(call: AcpToolCall): { id: string; paths: string[]; kind?: string; input: Record<string, unknown>; title?: string; events: AcpOutput[] } {
    const id = typeof call.toolCallId === 'string' && call.toolCallId ? call.toolCallId : this.newId();
    const t = this.tool(id);
    this.merge(t, call);
    const events: AcpOutput[] = [];
    this.emitCall(t, events);
    this.emitDiffs(t, events);
    return { id, paths: [...t.paths], kind: t.acpKind, input: t.input, title: t.title, events };
  }

  private toolUpdate(u: AcpToolCall, out: AcpOutput[]): void {
    if (typeof u.toolCallId !== 'string' || !u.toolCallId) return;
    const t = this.tool(u.toolCallId);
    this.merge(t, u);
    // Agents can open a call with nothing filled in yet (OpenCode: title
    // "write", rawInput {}), so the row waits for its input or its start.
    const under = u.status === 'in_progress' || u.status === 'completed' || u.status === 'failed';
    if (Object.keys(t.input).length || under) this.emitCall(t, out);
    if (t.emitted) this.emitDiffs(t, out);
    if ((u.status === 'completed' || u.status === 'failed') && !t.done) this.emitResult(t, u.status === 'completed', out);
  }

  private title(t: Tool): string {
    const command = typeof t.input.command === 'string' ? t.input.command : '';
    if (t.acpKind === 'execute' && command) return firstLine(command);
    if (writesFiles(t.acpKind) && t.paths.length === 1) return `Edit ${displayPath(t.paths[0], this.ctx.cwd)}`;
    return firstLine(t.title || t.name || t.acpKind || 'Tool');
  }

  private emitCall(t: Tool, out: AcpOutput[]): void {
    if (t.emitted) return;
    t.emitted = true;
    const name = t.name || t.title || t.acpKind || 'tool';
    const kind = name.startsWith('mcp__') ? 'mcp' : toolKind(t.acpKind);
    out.push({ kind: 'event', event: { type: 'tool.call', itemId: t.id, name, kind, title: this.title(t), input: truncateInput(t.input) } });
  }

  private emitDiffs(t: Tool, out: AcpOutput[]): void {
    for (const c of t.output) {
      if (c?.type !== 'diff' || typeof c.path !== 'string' || typeof c.newText !== 'string' || t.diffed.has(c.path)) continue;
      t.diffed.add(c.path);
      out.push({ kind: 'event', event: { type: 'edit.diff', itemId: t.id, path: c.path, hunks: diffLines(typeof c.oldText === 'string' ? c.oldText : '', c.newText) } });
    }
  }

  private emitResult(t: Tool, ok: boolean, out: AcpOutput[]): void {
    t.done = true;
    const texts: string[] = [];
    for (const c of t.output) {
      if (c?.type !== 'content' || !c.content) continue;
      if (c.content.type === 'text' && typeof c.content.text === 'string') texts.push(c.content.text);
    }
    if (!texts.length && isPlainObject(t.rawOutput)) {
      const said = t.rawOutput.output ?? t.rawOutput.error;
      if (typeof said === 'string') texts.push(said);
    }
    out.push({ kind: 'event', event: { type: 'tool.result', itemId: t.id, ok, ...truncateResultText(texts.join('\n')) } });
  }

  // The turn has ended, or the agent has gone: no more updates are coming
  // for anything still open.
  closeOpen(reason: string): AcpOutput[] {
    const out = this.flush();
    for (const t of this.tools.values()) {
      if (t.done || !t.emitted) continue;
      t.done = true;
      out.push({ kind: 'event', event: { type: 'tool.result', itemId: t.id, ok: false, text: reason, truncated: false } });
    }
    return out;
  }
}

function planEntries(raw: unknown[]): { text: string; status: 'pending' | 'in_progress' | 'completed' }[] {
  return raw.filter(isPlainObject).map((e) => ({
    text: typeof e.content === 'string' ? e.content : '',
    status: e.status === 'in_progress' || e.status === 'completed' ? e.status : 'pending',
  }));
}

// Whether a path someone reported is inside the given folder, resolved.
export const absolutePath = (p: string, cwd: string): string => path.resolve(cwd, p);
