// Adapted from threadbear (https://github.com/mikecann/threadbear), runner/src/adapters/acp/agents.ts @ 43fa197.
// MIT License, Copyright (c) 2026 Mike Cann. See THIRD_PARTY_NOTICES.md.
//
// Changes for Fhara: OpenCode only (the Cursor row, account discovery and
// the updater are dropped). opencodeEnv takes a base config (Fhara's own
// provider block from execution/nativeProvider.buildOpencodeConfig) and lays
// the ask-for-everything permissions over it, at the top level and on every
// built-in agent. Fhara keeps its stricter read rules (no .env files) and
// denies external directories, questions and push/remote commands outright.
// Loopback is added to NO_PROXY: `opencode acp` talks to its own local
// server, and an inherited HTTP(S)_PROXY broke session/new with
// "service failure: directory" (checked on 1.19.5, 11 Nov 2026).
import fs from 'node:fs';
import path from 'node:path';
import type { InitializeResult } from './connection';

// Every tool asks unless it only reads, so a tool an agent adds later asks
// too. Read of something outside the folder is denied (Fhara: the task
// worktree is the whole world), and so are .env files.
const ASK_FOR_EVERYTHING: Record<string, unknown> = {
  '*': 'ask',
  read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' },
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  external_directory: 'deny',
  question: 'deny',
  bash: { '*': 'ask', 'git push*': 'deny', 'git remote*': 'deny', 'gh pr merge*': 'deny' },
  // Fhara (skills plan S1): OpenCode's native skill loader would surface the
  // folder's .claude/.agents skills, never imported or validated in Fhara.
  skill: 'deny',
};
const DENY_EVERYTHING: Record<string, unknown> = { '*': 'deny' };

/** The agents OpenCode ships with; each gets the rules too (agent rules outrank top-level ones). */
export const OPENCODE_AGENTS = ['build', 'plan', 'general', 'explore'] as const;

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

function withLoopback(value: string | undefined): string {
  const parts = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const host of LOOPBACK) if (!parts.includes(host)) parts.push(host);
  return parts.join(',');
}

/**
 * The permission block and the config content for an ACP OpenCode.
 *
 * OpenCode runs anything without asking unless its config says otherwise,
 * and a folder's own opencode.json outranks the inline config (threadbear,
 * 1.18.23). So the folder's OpenCode config isn't read at all
 * (OPENCODE_DISABLE_PROJECT_CONFIG), and the rules go on the agents too.
 * Checked on 1.19.5: a repo with `permission: allow` still asked for every
 * write and command.
 */
export function opencodeConfig(o: { base?: Record<string, unknown>; noTools?: boolean } = {}): Record<string, unknown> {
  const permission = o.noTools ? DENY_EVERYTHING : ASK_FOR_EVERYTHING;
  const agent = Object.fromEntries(OPENCODE_AGENTS.map((name) => [name, { permission }]));
  return { ...(o.base ?? {}), autoupdate: false, share: 'disabled', permission, agent };
}

/** The variables set on every ACP OpenCode process (last, so nothing can take them off). */
export function opencodeEnv(o: { base?: Record<string, unknown>; noTools?: boolean; source?: Record<string, string | undefined> } = {}): Record<string, string> {
  const source = o.source ?? process.env;
  return {
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    // Fhara (skills plan S1): no .claude/.agents skill discovery either.
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(o)),
    NO_PROXY: withLoopback(source.NO_PROXY),
    no_proxy: withLoopback(source.no_proxy),
  };
}

// --pure: no plugins, the user's own included, for the same reason.
export const OPENCODE_ACP_ARGS = ['acp', '--pure'];

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The OpenCode binary: an explicit absolute path, or `opencode` on PATH.
 * Whole paths only: a relative one would resolve against the thread's
 * folder when it's run, and that can be anyone's repo.
 */
export function findOpencodeBinary(o: { explicit?: string; pathEnv?: string } = {}): string | undefined {
  if (o.explicit) {
    if (path.isAbsolute(o.explicit)) return isExecutableFile(o.explicit) ? o.explicit : undefined;
    if (o.explicit.includes('/') || o.explicit.includes('\\')) return undefined;
  }
  const name = o.explicit || 'opencode';
  for (const dir of (o.pathEnv ?? process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    if (isExecutableFile(file)) return file;
  }
  return undefined;
}

// Whether the process that answered initialize really is OpenCode, as the
// same command name can be another program's.
export function identifiesOpencode(init: InitializeResult): boolean {
  return /opencode/i.test(init.agentInfo?.name ?? '') || Boolean(init.authMethods?.some((m) => m.id === 'opencode-login'));
}
