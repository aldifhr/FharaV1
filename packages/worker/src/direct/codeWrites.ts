// Adapted from threadbear (https://github.com/mikecann/threadbear), runner/src/code-writes.ts @ 43fa197.
// MIT License, Copyright (c) 2026 Mike Cann. See THIRD_PARTY_NOTICES.md.
//
// Changes for Fhara: the list is Fhara's (OpenCode config and plugins, git
// hooks, husky, package.json scripts, CI workflows, editor tasks, Claude
// settings, .mcp.json) instead of threadbear's patch files; symlinks are
// resolved the same way (canonicalPath, unchanged).

// Files an agent's edit turns into code that runs by itself: a hook, a CI
// workflow, a package script, an OpenCode plugin or config. In a thread
// that isn't on Full access, writing one is running code, so permission to
// edit a file mustn't stand in for permission to run it: such an edit always
// asks, with no "Always allow", whatever the thread's rules say.
import fs from 'node:fs';
import path from 'node:path';

// Said on the approval card, after the edit's own title.
export const RUNS_AS_CODE = 'Fhara runs this file as code';
export const MAYBE_RUNS_AS_CODE = "Fhara can't tell whether this file runs as code";

// Whether a write runs as code, or might.
export type CodeWrite = boolean | 'unsure';

export const codeWriteNote = (kind: CodeWrite): string => (kind === 'unsure' ? MAYBE_RUNS_AS_CODE : RUNS_AS_CODE);

/** Folders whose files run as code (any depth). */
const CODE_DIRS = ['.opencode', '.husky', '.githooks'];
/** Exact file names that run as code wherever they are. */
const CODE_FILES = new Set(['opencode.json', 'opencode.jsonc', 'package.json', '.mcp.json', '.envrc', 'lefthook.yml', '.pre-commit-config.yaml']);

// By name alone, wherever it is, as written and as the disk has it.
export function runsAsCodeByName(file: string): boolean {
  return [path.resolve(file), canonicalPath(file)].some((p) => {
    const parts = p.replace(/\\/g, '/').toLowerCase().split('/');
    const name = parts[parts.length - 1] ?? '';
    const dir = parts[parts.length - 2] ?? '';
    if (CODE_FILES.has(name)) return true;
    if (parts.slice(0, -1).some((part) => CODE_DIRS.includes(part))) return true;
    // .git/hooks/*, .git/config (core.hooksPath, aliases, filters)
    const git = parts.lastIndexOf('.git');
    if (git !== -1 && (parts[git + 1] === 'hooks' || parts[git + 1] === 'config')) return true;
    // .github/workflows/*, .github/actions/*
    const gh = parts.lastIndexOf('.github');
    if (gh !== -1 && (parts[gh + 1] === 'workflows' || parts[gh + 1] === 'actions')) return true;
    if (dir === '.vscode' && name === 'tasks.json') return true;
    return dir === '.claude' && /^settings(\..*)?\.json$/.test(name);
  });
}

// `file` with the symlinks on its way resolved and each name as the disk
// spells it, as far as it exists; the rest as given. A link to something
// not there yet is followed too: a write through it makes its target.
export function canonicalPath(file: string, depth = 0): string {
  const abs = path.resolve(file);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    // missing, or a link to something missing
  }
  const up = path.dirname(abs);
  if (up === abs || depth > 40) return abs;
  const parent = canonicalPath(up, depth + 1);
  const here = path.join(parent, path.basename(abs));
  try {
    if (fs.lstatSync(here).isSymbolicLink()) return canonicalPath(path.resolve(parent, fs.readlinkSync(here)), depth + 1);
  } catch {
    // not there at all
  }
  return here;
}

/** True when any of `paths` runs as code. */
export function writeRunsAsCode(paths: readonly string[]): CodeWrite {
  return paths.some((p) => runsAsCodeByName(p));
}
