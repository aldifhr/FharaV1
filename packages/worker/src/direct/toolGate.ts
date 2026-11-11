// Adapted from threadbear (https://github.com/mikecann/threadbear), runner/src/adapters/tool-gate.ts and the
// request-shaping half of runner/src/adapters/acp/adapter.ts `permission()` @ 43fa197.
// MIT License, Copyright (c) 2026 Mike Cann. See THIRD_PARTY_NOTICES.md.
//
// Changes for Fhara: the policy itself (which mode allows what, push never
// automatic, rule matching) is decided by the backend
// (apps/api/convex/lib/directThreads.directApprovalPolicy) from the task's
// mode at the moment the call is asked, so every outcome is recorded as an
// approval row (rule 5). This module only describes the call exactly: the
// argv when it is a plain command, the real folder it runs in, the files it
// names, whether one runs as code, the thread rule key that would cover it,
// and the card input (all of it or nothing). Threadbear's 2.1k-line shell
// allowlist is NOT copied: a command that needs a shell has no argv here,
// and the backend makes it ask every time.
import fs from 'node:fs';
import path from 'node:path';
import { absolutePath, firstLine, displayPath, isPlainEdit, isPlainObject, writesFiles } from '@/vendor/threadbear/acp/normalize';
import { codeWriteNote, writeRunsAsCode, type CodeWrite } from './codeWrites';

// Where an execute call can say it runs (OpenCode's bash tool: workdir/cwd).
export const FOLDER_KEYS = ['workdir', 'cwd', 'workingDirectory', 'directory', 'dir'];
// What an execute call can carry that doesn't change what runs or where.
const BENIGN_KEYS = new Set(['description', 'timeout']);
/** Largest card input: a call too long to show whole is refused (threadbear cardInput 'all'). */
export const CARD_INPUT_MAX = 8_000;

// "Always allow" for a file edit in this thread (threadbear EDIT_RULE).
export const EDIT_RULE = 'acp:edit';

export function realFolder(p: string): string | undefined {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
}

const SHELL_META = /[|&;<>()$`*?{}[\]~!\n\r#]/;

/**
 * The words of a plain command (`npm run test -- --watch=false`), honouring
 * quotes and backslashes; null when anything would need a shell (pipes,
 * redirects, globs, substitutions, chaining, variables).
 */
export function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < command.length && '"\\'.includes(command[i + 1])) cur += command[++i];
      else if (ch === '$' || ch === '`') return null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 >= command.length) return null;
      cur += command[++i];
      has = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (has) words.push(cur);
      cur = '';
      has = false;
      continue;
    }
    if (SHELL_META.test(ch)) return null;
    cur += ch;
    has = true;
  }
  if (quote) return null;
  if (has) words.push(cur);
  // `FOO=1 cmd` sets an env: not a plain argv.
  if (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return null;
  return words.length ? words : null;
}

/** A thread rule: this exact command in this real folder (threadbear commandRule). */
export function commandRule(argv: readonly string[], folder: string): string {
  return `cmd:${folder}:${JSON.stringify(argv)}`;
}

export type ToolRequestDescription = {
  /** What the backend decides on (DirectToolRequest). */
  request: {
    acpKind: string;
    title: string;
    argv?: string[] | null;
    command?: string;
    paths?: string[];
    codeWrite?: CodeWrite;
    ruleKey?: string;
    cwd?: string;
    workspaceRoot?: string;
  };
  /** The whole input shown on the card, as JSON. */
  input: string;
  /** Set when the card would be too long to show whole: the call is refused. */
  tooLong?: number;
  /** Re-resolves the named folders; a change while the card waited refuses the call. */
  folders: () => string;
};

/**
 * Describe one ACP permission request exactly (threadbear permission(),
 * first half). `seen` is what earlier updates for the call said.
 */
export function describeToolCall(input: {
  cwd: string;
  kind: string | undefined;
  rawInput: Record<string, unknown>;
  paths: string[];
  title?: string;
  workspaceRoot?: string;
}): ToolRequestDescription {
  const { cwd } = input;
  const kind = input.kind ?? 'other';
  const raw = input.rawInput;
  const paths = [...new Set(input.paths.map((f) => absolutePath(f, cwd)))];
  const command = kind === 'execute' && typeof raw.command === 'string' ? raw.command : '';
  const argv = command ? shellWords(command) : null;
  // A tool can name its own folder (OpenCode's workdir): the rule and the
  // card go by where the command really runs, as the disk has it.
  const named = FOLDER_KEYS.map((k) => raw[k]).filter((d): d is string => typeof d === 'string' && d !== '');
  const resolve = () =>
    named.map((d) => {
      const disk = realFolder(path.isAbsolute(d) ? d : `${cwd}/${d}`);
      return disk !== undefined && disk === realFolder(absolutePath(d, cwd)) ? disk : undefined;
    });
  const places = resolve();
  const said = [...new Set(places.filter((d): d is string => d !== undefined))];
  const unknownPlace = places.includes(undefined);
  const where = said[0] ?? (named[0] !== undefined ? absolutePath(named[0], cwd) : (realFolder(cwd) ?? cwd));
  // A rule is for this command in this folder and nothing else; anything
  // else the call carries that could change what runs makes it inexact.
  const exact =
    Boolean(command) &&
    !unknownPlace &&
    said.length <= 1 &&
    Object.entries(raw).every(([k, v]) => k === 'command' || BENIGN_KEYS.has(k) || (FOLDER_KEYS.includes(k) && (typeof v === 'string' || v === undefined)));
  const ruleKey = exact && argv?.length ? commandRule(argv, where) : undefined;

  let codeWrite: CodeWrite = false;
  if (writesFiles(kind)) {
    // An edit with no named files can't be checked: it asks every time.
    codeWrite = paths.length ? writeRunsAsCode(paths) : 'unsure';
    if (!codeWrite && !isPlainEdit(raw)) codeWrite = 'unsure';
  } else if (paths.length && kind !== 'read' && kind !== 'search' && kind !== 'fetch' && kind !== 'think' && kind !== 'execute') {
    // A kind that doesn't say what it does, naming a file that runs.
    codeWrite = writeRunsAsCode(paths);
  }

  const baseTitle = command
    ? firstLine(command)
    : writesFiles(kind) && paths.length === 1
      ? `Edit ${displayPath(paths[0], cwd)}`
      : firstLine(input.title || kind || 'Use a tool');
  const title = codeWrite ? `${baseTitle} (${codeWriteNote(codeWrite)})` : baseTitle;
  const given = Object.fromEntries(FOLDER_KEYS.filter((k) => typeof raw[k] === 'string' && raw[k] !== where).map((k) => [k, raw[k]]));
  const shown: Record<string, unknown> = command
    ? exact
      ? { command, cwd: where, ...given }
      : { ...raw, command, ...(FOLDER_KEYS.some((k) => k in raw) ? {} : { cwd: where }) }
    : writesFiles(kind)
      ? { paths, ...raw }
      : raw;
  const cardText = JSON.stringify(shown, null, 2);
  const editRule = writesFiles(kind) && !codeWrite && paths.length > 0 ? EDIT_RULE : undefined;
  return {
    request: {
      acpKind: kind,
      title: title.slice(0, 300),
      ...(command ? { command: command.slice(0, 2000), argv: argv ?? null } : {}),
      ...(paths.length ? { paths: paths.slice(0, 50) } : {}),
      ...(codeWrite ? { codeWrite } : {}),
      ...(ruleKey ?? editRule ? { ruleKey: (ruleKey ?? editRule)!.slice(0, 1000) } : {}),
      cwd: where,
      ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    },
    input: cardText.length > CARD_INPUT_MAX ? '' : cardText,
    ...(cardText.length > CARD_INPUT_MAX ? { tooLong: cardText.length } : {}),
    folders: () => JSON.stringify(resolve()),
  };
}

/** What the agent is told when a card is too long to show whole. */
export function tooLongForCard(chars: number): string {
  return `A tool call was refused: its input (${chars} characters) is too long to show on an approval card, and Fhara never approves what it can't show. Ask the agent to do it in smaller steps.`;
}

/**
 * Why a permission request ended 'cancelled' for the agent (Nuphos N5): an
 * empty turn is always attributable. The worker names the first four; the
 * backend also closes cards for the thread closing, the session ending or
 * the worker dying (apps/api/convex/lib/directThreads.ts).
 *   interrupt   Stop, or the turn watchdog stopping the turn
 *   gate_error  the request couldn't be shaped or recorded
 *   no_option   the agent offered no plain allow/reject for the answer
 *   expired     nobody answered within DIRECT_APPROVAL_MAX_MIN
 */
export type ApprovalCancelReason = 'interrupt' | 'gate_error' | 'no_option' | 'expired' | 'closed' | 'session_ended' | 'worker_lost';


/** Names the abort of a pending request (AbortController.abort(reason)). */
export function cancelReasonOf(signal: AbortSignal, fallback: ApprovalCancelReason = 'interrupt'): ApprovalCancelReason {
  const r = signal.reason as unknown;
  return typeof r === 'string' && (CANCEL_REASONS as readonly string[]).includes(r) ? (r as ApprovalCancelReason) : fallback;
}

export const CANCEL_REASONS = ['interrupt', 'gate_error', 'no_option', 'expired', 'closed', 'session_ended', 'worker_lost'] as const;

/**
 * The runner's answer. `reason` says why a non-answer ended (expired,
 * interrupt); `recorded` means the store already wrote approval.resolved
 * for the card, so the engine's report is not written twice.
 */
export type ToolGateAnswer = {
  decision: 'allow' | 'deny' | 'expired';
  message?: string;
  approvalId?: string;
  reason?: ApprovalCancelReason;
  recorded?: boolean;
};

/** One request for a decision, as the session asks it of the runner. */
export type ToolGateCall = {
  itemId: string;
  description: ToolRequestDescription;
  signal: AbortSignal;
};

export type ToolGateDeps = {
  /** Records the request (auto row or pending card) and waits for the answer. */
  requestApproval(call: ToolGateCall): Promise<ToolGateAnswer>;
  note(text: string): void;
};

/**
 * Whether a tool call may run (threadbear gateThreadbearTool, ported).
 * All of it or nothing: a card cut short would approve words nobody saw.
 */
export type GateResult =
  | { allowed: true; approvalId?: string }
  | { allowed: false; message: string; approvalId?: string; reason?: ApprovalCancelReason; recorded?: boolean; expired?: boolean };

export async function gateToolCall(deps: ToolGateDeps, call: ToolGateCall): Promise<GateResult> {
  const { description } = call;
  if (description.tooLong !== undefined) {
    const message = tooLongForCard(description.tooLong);
    deps.note(message);
    return { allowed: false, message };
  }
  const before = description.folders();
  let answer: ToolGateAnswer;
  try {
    answer = await deps.requestApproval(call);
  } catch (error) {
    return {
      allowed: false,
      reason: 'gate_error',
      message: `The approval could not be recorded (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
  const ids = answer.approvalId ? { approvalId: answer.approvalId } : {};
  if (answer.decision !== 'allow') {
    const expired = answer.decision === 'expired';
    return {
      allowed: false,
      ...ids,
      message: answer.message || (expired ? 'The request expired before the user answered.' : 'The user denied this. Ask them how to proceed.'),
      ...(expired ? { expired: true, reason: answer.reason ?? 'expired', ...(answer.recorded ? { recorded: true } : {}) } : {}),
    };
  }
  // A link pointed somewhere else while the card waited: what was allowed
  // isn't where it would run now.
  if (description.folders() !== before) {
    const message = `The folder for "${description.request.title}" changed while it waited for an answer, so it wasn't run. The agent can ask again.`;
    deps.note(message);
    return { allowed: false, message, ...ids };
  }
  return { allowed: true, ...ids };
}

export { isPlainObject };
