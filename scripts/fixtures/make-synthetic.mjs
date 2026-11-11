#!/usr/bin/env node
// Writes the synthetic Fhara scenarios in fixtures/scenarios/ (safe to
// commit: made up, no real transcripts, no secrets, no real repositories).
// `npm run fixtures:seed` loads them into a local dev deployment; the golden
// tests replay their event streams through the UI selectors. Re-run after
// changing this file: `npm run fixtures:make`.
//
// Adapted from threadbear (https://github.com/mikecann/threadbear, MIT,
// commit b697f32), app/Tools/mock-runner/make-synthetic.mjs: the idea of a
// generator that writes commit-safe demo threads (thread.json +
// events.ndjson per scenario) and its sequenced `push(...)` event helper.
// Fhara's records, scenarios and the deterministic clock are its own.
//
// Output, per scenario:
//   fixtures/scenarios/<id>/scenario.json   meta + rows by table (no events)
//   fixtures/scenarios/<id>/events.ndjson    taskEvents / agentEvents, one per line, in order
//   fixtures/scenarios/index.json            the scenario list
//
// Rows carry a `fixtureKey` and reference each other with
// "$ref:<table>/<fixtureKey>" strings (whole value only); the seeder
// resolves them to real Convex ids. `agents` rows are looked up by role
// first and only created when the deployment has none.
// Timestamps start at a fixed BASE so the output is byte-identical on every
// run; the seeder shifts them to "now".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../fixtures/scenarios');
/** 2026-01-15T09:00:00Z. Every timestamp is BASE + n; never Date.now(). */
export const BASE = Date.UTC(2026, 0, 15, 9, 0, 0);
const WORKSPACE = '/tmp/fhara-fixtures';
const FORMAT = 1;

// ------------------------------------------------------------------ builder

function builder(id, meta) {
  const rows = {};
  const events = [];
  const seqByTask = new Map();
  const seqByConversation = new Map();
  let t = BASE;
  let anchor = null;
  const s = {
    id,
    meta,
    /** Advance the clock and return it (ms). */
    tick: (seconds = 6) => (t += seconds * 1000),
    now: () => t,
    ref: (table, key) => `$ref:${table}/${key}`,
    row(table, key, fields) {
      (rows[table] ??= []).push(key ? { fixtureKey: key, ...fields } : { ...fields });
      return key ? s.ref(table, key) : null;
    },
    agent(role, name = role.toUpperCase().length <= 3 ? role.toUpperCase() : role[0].toUpperCase() + role.slice(1)) {
      if (!(rows.agents ?? []).some((a) => a.fixtureKey === role)) {
        s.row('agents', role, { name, role, status: 'idle', isEnabled: true, capabilities: [] });
      }
      return s.ref('agents', role);
    },
    /** One taskEvents row with the next per-task sequence (plan 016). */
    taskEvent(taskRef, projectRef, type, payload = {}, extra = {}) {
      const sequence = (seqByTask.get(taskRef) ?? 0) + 1;
      seqByTask.set(taskRef, sequence);
      events.push({ table: 'taskEvents', taskId: taskRef, projectId: projectRef, type, payload, level: 'info', ...extra, sequence, createdAt: s.tick(extra.seconds ?? 4) });
      delete events[events.length - 1].seconds;
      return sequence;
    },
    /** One canonical agentEvents row, sequenced per conversation (else per task). */
    agentEvent(fields) {
      const key = fields.conversationId ?? `task:${fields.taskId}`;
      const sequence = (seqByConversation.get(key) ?? 0) + 1;
      seqByConversation.set(key, sequence);
      events.push({ table: 'agentEvents', payload: {}, ...fields, sequence, createdAt: s.tick(2) });
      return sequence;
    },
    lastSeq: (taskRef) => seqByTask.get(taskRef) ?? 0,
    /** The scenario moment the seeder maps to "now" (default: the clock at the end). */
    anchorAt: (ms) => (anchor = ms),
    done() {
      return { scenario: { format: FORMAT, id, ...meta, base: BASE, anchor: anchor ?? t, rows }, events };
    },
  };
  return s;
}

function project(s, name, extra = {}) {
  return s.row('projects', 'main', {
    name: `[fixture] ${name}`,
    workspacePath: `${WORKSPACE}/${s.id}`,
    mainBranch: 'main',
    createdAt: s.now(),
    ...extra,
  });
}

function conversation(s, projectRef, title, agents, extra = {}) {
  const conv = s.row('conversations', 'main', {
    ...(projectRef ? { projectId: projectRef } : {}),
    kind: projectRef ? 'project' : 'personal',
    title,
    status: 'active',
    createdAt: s.now(),
    lastMessageAt: s.now(),
    ...extra,
  });
  agents.forEach((agentRef, i) =>
    s.row('conversationParticipants', `p${i}`, { conversationId: conv, ...(projectRef ? { projectId: projectRef } : {}), agentId: agentRef, joinedAt: s.now() }),
  );
  return conv;
}

let msgCount = 0;
function message(s, fields) {
  return s.row('messages', fields.key ?? `m${++msgCount}`, { ...omit(fields, ['key']) });
}

function omit(obj, keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

const diff = (file, removed, added) =>
  [`--- a/${file}`, `+++ b/${file}`, `@@ -1,${removed.length + 1} +1,${added.length + 1} @@`, ' // fixture', ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join('\n') + '\n';

// ------------------------------------------------------------------ scenarios

/** 1. A planned task: plan → implement → review → verification → diff applied → pushed with a PR. */
function plannedPush() {
  const s = builder('planned-push', {
    title: 'Planned task completed with diff and push',
    description: 'CTO plans two subtasks; Frontend edits two files; Reviewer approves; verification passes; the user approved apply and push; a PR is open.',
    covers: ['tasks', 'plans', 'subtasks', 'taskEvents', 'agentEvents', 'messages', 'approvals', 'fileChanges', 'taskPushes', 'sideEffects', 'taskBriefs', 'memories'],
  });
  const cto = s.agent('cto');
  const fe = s.agent('frontend');
  const rv = s.agent('reviewer');
  const p = project(s, 'Planned task with push', { agentIds: [cto, fe, rv] });
  const conv = conversation(s, p, 'Empty state for the orders list', [cto, fe, rv]);
  const command = 'Add an empty state to the orders list: an icon, one line of copy, and a "Create order" button.';
  const task = s.row('tasks', 'main', {
    projectId: p, conversationId: conv, title: 'Empty state for the orders list', command,
    status: 'done', planVersion: 1, strategy: 'dag', classification: 'implementation', replanCount: 0,
    startedAt: s.tick(), completedAt: BASE + 15 * 60_000, updatedAt: BASE + 15 * 60_000,
    branchName: 'fhara/t/orders-empty-state', worktreePath: `${WORKSPACE}/planned-push/.worktrees/orders-empty-state`,
    assignedAgentIds: [fe, rv], permissionMode: 'supervised', sprint: 1, phase: 'done',
    eventSequence: 0,
    requirements: [
      { id: 'r1', text: 'Show an icon and one line of copy when there are no orders', source: 'llm' },
      { id: 'r2', text: 'Offer a "Create order" button', source: 'llm' },
    ],
    requirementCoverage: { checkedAt: BASE + 14 * 60_000, outcome: 'covered', covered: ['r1', 'r2'], missingEvidence: [], uncovered: [] },
  });
  s.row('plans', 'v1', {
    taskId: task, projectId: p, version: 1, strategy: 'dag', createdBy: 'orchestrator', goal: 'Orders list shows a helpful empty state',
    payload: {
      goal: 'Orders list shows a helpful empty state', strategy: 'dag', requiresApproval: true, maxConcurrency: 1,
      subtasks: [
        { key: 'implement', title: 'Build the empty state', kind: 'code_change', capability: 'frontend-development', dependencies: [], order: 0, allowedPaths: ['src/orders'], requirementIds: ['r1', 'r2'] },
        { key: 'review', title: 'Review the diff', kind: 'review', capability: 'code-review', dependencies: ['implement'], order: 1, requirementIds: ['r1', 'r2'] },
      ],
    },
    estimate: { minutes: { low: 6, high: 14 }, confidence: 'medium' },
    createdAt: s.tick(),
  });
  s.row('subtasks', 'implement', {
    taskId: task, projectId: p, key: 'implement', title: 'Build the empty state', description: 'Add OrdersEmptyState and render it from OrdersList when the list is empty.',
    kind: 'code_change', capability: 'frontend-development', dependencies: [], order: 0, allowedPaths: ['src/orders'], status: 'completed', origin: 'plan',
    assignedAgentId: fe, assignedAgentName: 'Frontend', attempts: 1, startedAt: s.tick(), completedAt: s.tick(240),
    output: 'Added OrdersEmptyState (icon, copy, Create order button) and rendered it from OrdersList.',
    objective: 'An empty orders list shows the empty state', deliverable: 'Diff of src/orders', requirementIds: ['r1', 'r2'],
    acceptance: [{ id: 'typecheck', criterion: 'Typecheck passes', check: 'typecheck' }, { id: 'tests', criterion: 'Relevant tests pass', check: 'test' }],
    acceptanceStatus: 'accepted',
  });
  s.row('subtasks', 'review', {
    taskId: task, projectId: p, key: 'review', title: 'Review the diff', description: 'Review the empty-state diff.', kind: 'review', capability: 'code-review',
    dependencies: ['implement'], order: 1, status: 'completed', origin: 'plan', assignedAgentId: rv, assignedAgentName: 'Reviewer', attempts: 1,
    startedAt: s.tick(), completedAt: s.tick(60), output: 'Approved. Copy and button match the design tokens; no regressions found.', requirementIds: ['r1', 'r2'],
  });
  const files = [
    { path: 'src/orders/OrdersEmptyState.tsx', changeType: 'new', additions: 18, deletions: 0 },
    { path: 'src/orders/OrdersList.tsx', changeType: 'modified', additions: 3, deletions: 1 },
  ];
  s.row('fileChanges', 'f1', {
    taskId: task, projectId: p, filePath: files[0].path, changeType: 'new', newContent: 'export function OrdersEmptyState() {\n  return null; // fixture\n}\n',
    diff: diff(files[0].path, [], ['export function OrdersEmptyState() {', '  return null; // fixture', '}']), subtaskKey: 'implement', approvedAt: BASE + 11 * 60_000, appliedAt: BASE + 11 * 60_000, appliedByWorkerId: 'fixture-worker',
  });
  s.row('fileChanges', 'f2', {
    taskId: task, projectId: p, filePath: files[1].path, changeType: 'modified', oldContent: 'return <Table rows={orders} />;\n', newContent: 'if (orders.length === 0) return <OrdersEmptyState />;\nreturn <Table rows={orders} />;\n',
    diff: diff(files[1].path, ['return <Table rows={orders} />;'], ['if (orders.length === 0) return <OrdersEmptyState />;', 'return <Table rows={orders} />;']), subtaskKey: 'implement', approvedAt: BASE + 11 * 60_000, appliedAt: BASE + 11 * 60_000, appliedByWorkerId: 'fixture-worker',
  });
  s.row('approvals', 'plan', { taskId: task, projectId: p, kind: 'plan', summary: 'Review the plan (2 subtasks)', planVersion: 1, status: 'approved', resolvedAt: s.tick(), decidedBy: 'user' });
  s.row('approvals', 'apply', { taskId: task, projectId: p, kind: 'apply_changes', summary: 'Apply 2 file changes', subtaskKey: 'implement', status: 'approved', resolvedAt: BASE + 11 * 60_000, decidedBy: 'user', requestedByAgentId: fe, toolName: 'apply_changes' });
  s.row('approvals', 'push', { taskId: task, projectId: p, kind: 'git_push', summary: 'Push fhara/t/orders-empty-state and open a PR', status: 'approved', resolvedAt: BASE + 13 * 60_000, decidedBy: 'user', toolName: 'git_push' });
  const push = s.row('taskPushes', 'push', {
    taskId: task, projectId: p, conversationId: conv, messageId: s.ref('messages', 'push-card'), branchName: 'fhara/t/orders-empty-state', commitSha: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c',
    commitMessage: 'feat(orders): empty state with Create order button', filesChanged: 2, additions: 21, deletions: 1, ahead: 1, behind: 0, comparedTo: 'main',
    status: 'pushed', openPr: true, approvalId: s.ref('approvals', 'push'), requestedAt: BASE + 13 * 60_000, attempts: 1, pushedAt: BASE + 14 * 60_000, baseBranch: 'main',
    repoFullName: 'example-org/acme-shop', prNumber: 42, prUrl: 'https://github.com/example-org/acme-shop/pull/42', prTitle: 'Empty state for the orders list', prState: 'open',
    headSha: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c', ciState: 'passed', ciChecks: [{ name: 'ci / test', status: 'passed', conclusion: 'success' }], reviewState: 'none', mergeable: 'mergeable',
    createdAt: BASE + 12 * 60_000, updatedAt: BASE + 14 * 60_000,
  });
  s.row('sideEffects', 'push', { key: 'push:fixture:planned-push:0f1e2d3', kind: 'push', phase: 'terminal', outcome: 'done', taskId: task, projectId: p, pushId: push, attempts: 1, evidence: { remoteSha: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c' }, armedAt: BASE + 13 * 60_000, acceptedAt: BASE + 14 * 60_000, settledAt: BASE + 14 * 60_000, createdAt: BASE + 13 * 60_000, updatedAt: BASE + 14 * 60_000 });
  s.row('sideEffects', 'pr', { key: 'pr_create:fixture:planned-push:42', kind: 'pr_create', phase: 'terminal', outcome: 'done', taskId: task, projectId: p, pushId: push, attempts: 1, evidence: { prNumber: 42 }, armedAt: BASE + 14 * 60_000, acceptedAt: BASE + 14 * 60_000, settledAt: BASE + 14 * 60_000, createdAt: BASE + 14 * 60_000, updatedAt: BASE + 14 * 60_000 });
  s.row('taskBriefs', 'brief', { taskId: task, projectId: p, objective: 'Orders list shows a helpful empty state', owner: 'Frontend', latestResult: 'Pushed fhara/t/orders-empty-state; PR #42 is open and CI passed.', openQuestions: [], nextStep: 'Merge PR #42 when ready.', updatedAt: BASE + 14 * 60_000, updatedBy: 'worker' });
  s.row('memories', 'm1', { scope: 'project', projectId: p, title: 'Empty states', content: 'Empty states use the muted icon, one sentence of copy and a single primary action.', tags: ['ui', 'fixture'], pinned: true, source: 'user', createdAt: BASE, updatedAt: BASE });

  // Chat timeline.
  message(s, { projectId: p, conversationId: conv, authorType: 'user', content: command, clientId: 'fixture-planned-1' });
  message(s, { projectId: p, conversationId: conv, taskId: task, agentId: cto, authorType: 'agent', content: 'Planned 2 subtasks: Frontend builds the empty state, Reviewer checks the diff.', card: { kind: 'assignment', data: { taskId: task, title: 'Empty state for the orders list', assignees: [{ agentId: fe, name: 'Frontend', role: 'frontend' }, { agentId: rv, name: 'Reviewer', role: 'reviewer' }], assignedBy: 'CTO' } } });
  message(s, { projectId: p, conversationId: conv, taskId: task, agentId: fe, authorType: 'agent', content: 'Read 3 files', subtaskKey: 'implement' });
  message(s, { projectId: p, conversationId: conv, taskId: task, agentId: fe, authorType: 'agent', content: 'Changed 2 files', subtaskKey: 'implement', card: { kind: 'changes', data: { taskId: task, subtaskKey: 'implement', files, additions: 21, deletions: 1 } } });
  message(s, { projectId: p, conversationId: conv, taskId: task, agentId: fe, authorType: 'agent', content: 'Verification passed', card: { kind: 'verification', data: { taskId: task, iteration: 0, phase: 0, outcome: 'passed', checks: [{ name: 'typecheck', status: 'passed', durationMs: 8200 }, { name: 'test', status: 'passed', durationMs: 4100, counts: { passed: 12, total: 12 } }], durationMs: 12300 } } });
  message(s, { key: 'push-card', projectId: p, conversationId: conv, taskId: task, agentId: cto, authorType: 'agent', content: 'Ready to push fhara/t/orders-empty-state.', card: { kind: 'push', data: { taskId: task, pushId: push, branchName: 'fhara/t/orders-empty-state', commitSha: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c', commitMessage: 'feat(orders): empty state with Create order button', filesChanged: 2, additions: 21, deletions: 1, ahead: 1, behind: 0 } } });
  message(s, { projectId: p, conversationId: conv, taskId: task, agentId: cto, authorType: 'agent', content: 'Done. The orders list now shows an empty state with a Create order button. Pushed and opened PR #42; CI passed.' });

  // Event stream.
  const te = (type, payload, extra) => s.taskEvent(task, p, type, payload, extra);
  const ae = (type, payload, agentId) => s.agentEvent({ projectId: p, conversationId: conv, taskId: task, type, payload, ...(agentId ? { agentId } : {}) });
  te('task.created', { command });
  ae('message.created', { text: command });
  te('task.classified', { kind: 'implementation', complexity: 'medium', suggestedCapabilities: ['frontend-development'] });
  te('plan.created', { version: 1, subtasks: 2, strategy: 'dag' });
  te('approval.requested', { kind: 'plan', version: 1 });
  te('approval.resolved', { kind: 'plan', decision: 'approved' });
  te('subtask.routed', { subtaskKey: 'implement', agent: 'Frontend', capability: 'frontend-development' }, { subtaskKey: 'implement', agentId: fe });
  te('subtask.started', {}, { subtaskKey: 'implement', agentId: fe });
  ae('agent.started', { subtaskKey: 'implement' }, fe);
  ae('agent.thinking', { text: 'Find where OrdersList renders the table.' }, fe);
  te('tool.read_file', { path: 'src/orders/OrdersList.tsx' }, { subtaskKey: 'implement', agentId: fe });
  ae('agent.tool.started', { tool: 'read_file', target: 'src/orders/OrdersList.tsx' }, fe);
  ae('agent.tool.completed', { tool: 'read_file', ok: true }, fe);
  te('tool.write_file', { path: 'src/orders/OrdersEmptyState.tsx' }, { subtaskKey: 'implement', agentId: fe });
  te('tool.edit_file', { path: 'src/orders/OrdersList.tsx' }, { subtaskKey: 'implement', agentId: fe });
  te('subtask.completed', { files: 2 }, { subtaskKey: 'implement', agentId: fe, seconds: 30 });
  ae('agent.completed', { subtaskKey: 'implement' }, fe);
  te('subtask.routed', { subtaskKey: 'review', agent: 'Reviewer', capability: 'code-review' }, { subtaskKey: 'review', agentId: rv });
  te('subtask.started', {}, { subtaskKey: 'review', agentId: rv });
  te('review.approved', { verdict: 'approve', findings: 0 }, { subtaskKey: 'review', agentId: rv });
  te('subtask.completed', {}, { subtaskKey: 'review', agentId: rv });
  te('approval.requested', { kind: 'apply_changes', files: 2 });
  ae('agent.waiting_approval', { kind: 'apply_changes' }, fe);
  te('approval.resolved', { kind: 'apply_changes', decision: 'approved' });
  te('changes.applied', { files: 2 });
  te('verification.passed', { iteration: 0, checks: ['typecheck', 'test'] });
  te('approval.requested', { kind: 'git_push' });
  te('approval.resolved', { kind: 'git_push', decision: 'approved' });
  te('push.completed', { branch: 'fhara/t/orders-empty-state', prNumber: 42 });
  te('requirements.covered', { covered: ['r1', 'r2'] });
  te('task.completed', { summary: 'Pushed; PR #42 open' });
  ae('task.completed', { status: 'done' });
  s.anchorAt(BASE + 16 * 60_000);
  return s.done();
}

/** 2. A running task waiting on a run_command approval card. */
function commandApproval() {
  const s = builder('command-approval', {
    title: 'Waiting for a command approval',
    description: 'Backend wants to run `npm run test`; the card waits with Allow / Always allow / Deny. The task keeps running (in-process wait).',
    covers: ['tasks', 'subtasks', 'approvals', 'taskEvents', 'agentEvents', 'messages', 'taskBriefs'],
  });
  const cto = s.agent('cto');
  const be = s.agent('backend');
  const p = project(s, 'Command approval', { agentIds: [cto, be] });
  const conv = conversation(s, p, 'Fix the price rounding test', [cto, be]);
  const command = 'The price rounding test fails on 0.005. Fix it and run the tests.';
  const task = s.row('tasks', 'main', {
    projectId: p, conversationId: conv, title: 'Fix the price rounding test', command, status: 'running', planVersion: 1, strategy: 'single', classification: 'debugging',
    startedAt: s.tick(), updatedAt: BASE + 5 * 60_000, workerId: 'fixture-worker', leaseExpiresAt: BASE + 60 * 60_000, assignedAgentIds: [be], permissionMode: 'supervised', sprint: 1, phase: 'implementation', eventSequence: 0,
  });
  s.row('subtasks', 'fix', {
    taskId: task, projectId: p, key: 'fix', title: 'Fix rounding and run tests', description: 'Round half away from zero in formatPrice; run npm run test.', kind: 'code_change', capability: 'backend-development',
    dependencies: [], order: 0, allowedPaths: ['src/pricing'], status: 'waiting_approval', origin: 'plan', assignedAgentId: be, assignedAgentName: 'Backend', attempts: 1, startedAt: s.tick(), activity: 'Waiting for your approval to run npm run test', activityAt: s.tick(),
  });
  s.row('approvals', 'cmd', {
    taskId: task, projectId: p, kind: 'run_command', summary: 'Run npm run test', subtaskKey: 'fix', status: 'pending', requestedByAgentId: be, toolName: 'run_command',
    payload: { command: 'npm run test', head: 'npm run test', argv: ['npm', 'run', 'test'], cwd: '.' }, arguments: { command: 'npm', args: ['run', 'test'] }, offerAlways: true, expiresAt: BASE + 60 * 60_000,
  });
  s.row('taskBriefs', 'brief', { taskId: task, projectId: p, objective: 'Rounding test passes', owner: 'Backend', latestResult: 'Patched formatPrice; waiting to run the tests.', openQuestions: [], nextStep: 'Approve `npm run test`.', updatedAt: s.now(), updatedBy: 'worker' });
  message(s, { projectId: p, conversationId: conv, authorType: 'user', content: command, clientId: 'fixture-cmd-1' });
  message(s, { projectId: p, conversationId: conv, taskId: task, agentId: be, authorType: 'agent', content: 'I changed formatPrice to round half away from zero. I need to run `npm run test` to confirm.', toolSteps: [{ tool: 'read_file', target: 'src/pricing/format.ts', ok: true, at: s.tick() }, { tool: 'edit_file', target: 'src/pricing/format.ts', ok: true, at: s.tick() }], intentLine: 'Fix the rounding and run the tests' });
  const te = (type, payload, extra) => s.taskEvent(task, p, type, payload, extra);
  te('task.created', { command });
  te('task.classified', { kind: 'debugging' });
  te('plan.created', { version: 1, subtasks: 1, strategy: 'single' });
  te('subtask.started', {}, { subtaskKey: 'fix', agentId: be });
  s.agentEvent({ projectId: p, conversationId: conv, taskId: task, agentId: be, type: 'agent.started', payload: { subtaskKey: 'fix' } });
  te('tool.edit_file', { path: 'src/pricing/format.ts' }, { subtaskKey: 'fix', agentId: be });
  te('approval.requested', { kind: 'run_command', command: 'npm run test' }, { subtaskKey: 'fix', agentId: be });
  s.agentEvent({ projectId: p, conversationId: conv, taskId: task, agentId: be, type: 'agent.waiting_approval', payload: { kind: 'run_command', command: 'npm run test' } });
  s.anchorAt(BASE + 6 * 60_000);
  return s.done();
}

/** 3. A task held by a provider rate limit, with Resume. */
function heldResume() {
  const s = builder('held-resume', {
    title: 'Held by a provider rate limit (Resume)',
    description: 'The provider answered 429; the task is paused with pausedBy "held" and resumes on its own at resumeAt, or on the Resume button.',
    covers: ['tasks', 'subtasks', 'taskEvents', 'agentEvents', 'messages', 'holds'],
  });
  const cto = s.agent('cto');
  const fe = s.agent('frontend');
  const p = project(s, 'Held task', { agentIds: [cto, fe] });
  const conv = conversation(s, p, 'Dark mode toggle', [cto, fe]);
  const command = 'Add a dark mode toggle to the settings page.';
  const heldAt = BASE + 6 * 60_000;
  const task = s.row('tasks', 'main', {
    projectId: p, conversationId: conv, title: 'Dark mode toggle', command, status: 'paused', pausedBy: 'held', pausedAt: heldAt, planVersion: 1, strategy: 'single', classification: 'implementation',
    startedAt: s.tick(), updatedAt: heldAt, assignedAgentIds: [fe], permissionMode: 'supervised', sprint: 1, phase: 'implementation', eventSequence: 0,
    hold: { kind: 'rate_limit', reason: 'The model provider is rate limiting requests (429).', detail: 'HTTP 429 from the fixture provider', attempts: 2, heldAt, resumeAt: heldAt + 4 * 60_000 },
  });
  s.row('subtasks', 'toggle', {
    taskId: task, projectId: p, key: 'toggle', title: 'Add the toggle', description: 'Add a theme switch to Settings › Appearance.', kind: 'code_change', capability: 'frontend-development', dependencies: [], order: 0,
    allowedPaths: ['src/settings'], status: 'running', origin: 'plan', assignedAgentId: fe, assignedAgentName: 'Frontend', attempts: 1, startedAt: s.tick(), activity: 'Waiting for the model', activityAt: heldAt,
  });
  message(s, { projectId: p, conversationId: conv, authorType: 'user', content: command, clientId: 'fixture-held-1' });
  message(s, { projectId: p, conversationId: conv, taskId: task, agentId: cto, authorType: 'agent', content: 'Paused: the model provider is rate limiting requests. I will retry automatically, or press Resume.' });
  const te = (type, payload, extra) => s.taskEvent(task, p, type, payload, extra);
  te('task.created', { command });
  te('plan.created', { version: 1, subtasks: 1, strategy: 'single' });
  te('subtask.started', {}, { subtaskKey: 'toggle', agentId: fe });
  te('llm.call_failed', { status: 429, attempt: 1 }, { level: 'warn', subtaskKey: 'toggle' });
  te('llm.call_failed', { status: 429, attempt: 2 }, { level: 'warn', subtaskKey: 'toggle' });
  te('task.held', { kind: 'rate_limit', attempts: 2, resumeAt: heldAt + 4 * 60_000 }, { level: 'warn' });
  s.agentEvent({ projectId: p, conversationId: conv, taskId: task, type: 'task.updated', payload: { status: 'paused', pausedBy: 'held' } });
  // One minute after the hold: Resume is offered and resumeAt is 3 minutes away.
  s.anchorAt(heldAt + 60_000);
  return s.done();
}

/** 4. Verification fails three times; the task fails. */
function verifyLoopFailed() {
  const s = builder('verify-loop-failed', {
    title: 'Failed verification loop',
    description: 'Verification fails on the first run and on two fix rounds; the fix cap is reached and the task fails with the log tail.',
    covers: ['tasks', 'subtasks', 'taskEvents', 'agentEvents', 'messages', 'fileChanges', 'approvals', 'taskBriefs'],
  });
  const cto = s.agent('cto');
  const be = s.agent('backend');
  const p = project(s, 'Failed verify loop', { agentIds: [cto, be] });
  const conv = conversation(s, p, 'CSV export', [cto, be]);
  const command = 'Add CSV export to the invoices API.';
  const err = 'Verification failed after 3 runs (typecheck): src/invoices/export.ts(14,7): error TS2322: Type \'string | undefined\' is not assignable to type \'string\'.';
  const task = s.row('tasks', 'main', {
    projectId: p, conversationId: conv, title: 'CSV export for invoices', command, status: 'failed', planVersion: 1, strategy: 'single', classification: 'implementation',
    startedAt: s.tick(), completedAt: BASE + 20 * 60_000, updatedAt: BASE + 20 * 60_000, errorMessage: err, assignedAgentIds: [be], permissionMode: 'auto_edits', sprint: 1, phase: 'verification', eventSequence: 0,
  });
  s.row('subtasks', 'export', {
    taskId: task, projectId: p, key: 'export', title: 'CSV export endpoint', description: 'GET /invoices/export.csv', kind: 'code_change', capability: 'backend-development', dependencies: [], order: 0,
    allowedPaths: ['src/invoices'], status: 'completed', origin: 'plan', assignedAgentId: be, assignedAgentName: 'Backend', attempts: 1, startedAt: s.tick(), completedAt: s.tick(120), acceptanceStatus: 'rejected', acceptanceReason: 'typecheck failed',
  });
  for (const n of [1, 2]) {
    s.row('subtasks', `fix-${n}`, {
      taskId: task, projectId: p, key: `verify-fix-${n}`, title: `Fix verification (round ${n})`, description: 'Fix the failing typecheck.', kind: 'code_change', capability: 'backend-development', dependencies: ['export'], order: n,
      allowedPaths: ['src/invoices'], status: n === 2 ? 'failed' : 'completed', origin: 'fix', assignedAgentId: be, assignedAgentName: 'Backend', attempts: 1, startedAt: s.tick(), completedAt: s.tick(90), ...(n === 2 ? { error: 'Verification still failing' } : {}),
    });
  }
  s.row('fileChanges', 'f1', { taskId: task, projectId: p, filePath: 'src/invoices/export.ts', changeType: 'new', newContent: 'export const toCsv = () => ""; // fixture\n', diff: diff('src/invoices/export.ts', [], ['export const toCsv = () => ""; // fixture']), subtaskKey: 'export', approvedAt: s.now(), appliedAt: s.now(), appliedByWorkerId: 'fixture-worker' });
  s.row('approvals', 'apply', { taskId: task, projectId: p, kind: 'apply_changes', summary: 'Apply 1 file change', subtaskKey: 'export', status: 'approved', resolvedAt: s.now(), decidedBy: 'auto' });
  s.row('taskBriefs', 'brief', { taskId: task, projectId: p, objective: 'CSV export for invoices', owner: 'Backend', latestResult: 'Failed: typecheck still fails after 2 fix rounds.', openQuestions: ['Should `customerName` be optional in the CSV?'], nextStep: 'Retry with a note, or fix the type by hand.', updatedAt: BASE + 20 * 60_000, updatedBy: 'worker' });
  message(s, { projectId: p, conversationId: conv, authorType: 'user', content: command, clientId: 'fixture-verify-1' });
  const tail = "src/invoices/export.ts(14,7): error TS2322: Type 'string | undefined' is not assignable to type 'string'.\nFound 1 error in src/invoices/export.ts:14";
  for (const iteration of [0, 1, 2]) {
    message(s, { projectId: p, conversationId: conv, taskId: task, agentId: be, authorType: 'agent', content: `Verification failed (run ${iteration + 1})`, card: { kind: 'verification', data: { taskId: task, iteration, phase: 0, outcome: 'failed', checks: [{ name: 'typecheck', status: 'failed', durationMs: 7000 + iteration * 100 }, { name: 'test', status: 'not_run', detail: 'skipped after typecheck failed' }], durationMs: 7000, logTail: tail } } });
  }
  message(s, { projectId: p, conversationId: conv, taskId: task, agentId: cto, authorType: 'agent', content: `The task failed: ${err}` });
  const te = (type, payload, extra) => s.taskEvent(task, p, type, payload, extra);
  te('task.created', { command });
  te('plan.created', { version: 1, subtasks: 1, strategy: 'single' });
  te('subtask.started', {}, { subtaskKey: 'export', agentId: be });
  te('subtask.completed', {}, { subtaskKey: 'export', agentId: be });
  te('changes.applied', { files: 1 });
  for (const iteration of [0, 1, 2]) {
    te('verification.failed', { iteration, step: 'typecheck' }, { level: 'error' });
    if (iteration < 2) {
      te('subtask.started', { origin: 'fix' }, { subtaskKey: `verify-fix-${iteration + 1}`, agentId: be });
      te(iteration === 1 ? 'subtask.failed' : 'subtask.completed', {}, { subtaskKey: `verify-fix-${iteration + 1}`, agentId: be, ...(iteration === 1 ? { level: 'error' } : {}) });
    }
  }
  te('verification.exhausted', { runs: 3 }, { level: 'error' });
  te('task.failed', { error: err }, { level: 'error' });
  s.agentEvent({ projectId: p, conversationId: conv, taskId: task, type: 'task.failed', payload: { error: err } });
  s.anchorAt(BASE + 21 * 60_000);
  return s.done();
}

/** 5. A personal chat with the CTO (no project). */
function personalChat() {
  const s = builder('personal-chat', {
    title: 'Personal chat',
    description: 'A personal conversation with the CTO: no project, a streamed reply with reasoning and a quoted follow-up.',
    covers: ['conversations', 'conversationParticipants', 'messages'],
  });
  const cto = s.agent('cto');
  // agentEvents need a projectId, so a personal chat has none: only messages.
  // No ownerId: personal chats are owned by the (single, unauthenticated) viewer, null.
  const conv = conversation(s, null, 'CTO', [cto], { agentId: cto });
  const q = message(s, { conversationId: conv, authorType: 'user', content: 'Should we keep the settings in SQLite or in JSON files?', clientId: 'fixture-personal-1', replyStatus: 'answered' });
  message(s, {
    conversationId: conv, agentId: cto, authorType: 'agent', replyToMessageId: q,
    reasoning: 'Settings are small, read at startup, edited rarely. Concurrency and migrations matter more than speed.', reasoningDurationMs: 2400,
    content: 'JSON files, for now. Settings are small and edited rarely, so a file you can read and diff beats a database. Move to SQLite once two processes write them at the same time.',
  });
  const q2 = message(s, { conversationId: conv, authorType: 'user', content: 'What breaks first if two processes write?', clientId: 'fixture-personal-2', replyStatus: 'answered', quotedMessageId: s.ref('messages', 'm' + msgCount) });
  message(s, { conversationId: conv, agentId: cto, authorType: 'agent', replyToMessageId: q2, content: 'Lost updates: both read, both write, the last write wins. Write to a temp file and rename it, and keep a version number to detect the conflict.' });
  return s.done();
}

/** 6. A research fan-out where one angle fails. */
function researchFanout() {
  const s = builder('research-fanout', {
    title: 'Research fan-out with one failed angle',
    description: 'Three research assistants run in parallel; RA-2 times out; the synthesis answers from RA-1 and RA-3 and says which angle is missing.',
    covers: ['tasks', 'plans', 'subtasks', 'taskEvents', 'agentEvents', 'messages', 'taskBriefs', 'memories'],
  });
  const cto = s.agent('cto');
  const rs = s.agent('researcher');
  const p = project(s, 'Research fan-out', { agentIds: [cto, rs] });
  const conv = conversation(s, p, 'Queue options', [cto, rs]);
  const command = 'Compare three ways to run background jobs for our app: a cron table, a Redis queue, and the database outbox pattern.';
  const angles = [
    { key: 'ra-1', title: 'Cron table', ok: true, out: 'Simplest; no new service. Weak on retries and fan-out. Sources: docs/jobs.md, example.com/cron-guide.' },
    { key: 'ra-2', title: 'Redis queue', ok: false, err: 'Subtask timed out after 600 s' },
    { key: 'ra-3', title: 'Outbox pattern', ok: true, out: 'Exactly-once with the write; needs a relay. Sources: docs/db.md, example.com/outbox.' },
  ];
  const task = s.row('tasks', 'main', {
    projectId: p, conversationId: conv, title: 'Background job options', command, status: 'done', planVersion: 1, strategy: 'dag', classification: 'research', startedAt: s.tick(), completedAt: BASE + 18 * 60_000, updatedAt: BASE + 18 * 60_000,
    assignedAgentIds: [rs], permissionMode: 'supervised', sprint: 1, phase: 'done', eventSequence: 0,
  });
  s.row('plans', 'v1', {
    taskId: task, projectId: p, version: 1, strategy: 'dag', createdBy: 'orchestrator', goal: 'A recommendation with evidence',
    payload: { goal: 'A recommendation with evidence', strategy: 'dag', requiresApproval: false, subtasks: [...angles.map((a, i) => ({ key: a.key, title: a.title, kind: 'research', capability: 'research', dependencies: [], order: i })), { key: 'synth', title: 'Synthesis', kind: 'research', capability: 'research', dependencies: angles.map((a) => a.key), order: 3 }] },
    createdAt: s.tick(),
  });
  angles.forEach((a, i) => {
    s.row('subtasks', a.key, {
      taskId: task, projectId: p, key: a.key, title: `RA-${i + 1}: ${a.title}`, description: `Research angle: ${a.title}`, kind: 'research', capability: 'research', dependencies: [], order: i, status: a.ok ? 'completed' : 'failed',
      origin: 'plan', assignedAgentId: rs, assignedAgentName: 'Researcher', attempts: a.ok ? 1 : 2, startedAt: BASE + 60_000, completedAt: BASE + (a.ok ? 8 : 11) * 60_000, ...(a.ok ? { output: a.out } : { error: a.err }),
    });
  });
  const answer = 'Use the outbox pattern for jobs that must follow a write, and a cron table for periodic work. The Redis queue angle did not finish (timed out), so it is not compared here; rerun it if you need high fan-out.';
  s.row('subtasks', 'synth', { taskId: task, projectId: p, key: 'synth', title: 'Synthesis', description: 'Merge the reports.', kind: 'research', capability: 'research', dependencies: angles.map((a) => a.key), order: 3, status: 'completed', origin: 'plan', assignedAgentId: rs, assignedAgentName: 'Researcher', attempts: 1, startedAt: BASE + 12 * 60_000, completedAt: BASE + 17 * 60_000, output: answer });
  s.row('taskBriefs', 'brief', { taskId: task, projectId: p, objective: 'Pick a background job approach', owner: 'Researcher', latestResult: answer, openQuestions: ['Rerun the Redis queue angle?'], nextStep: 'Decide, or rerun RA-2.', updatedAt: BASE + 18 * 60_000, updatedBy: 'worker' });
  s.row('memories', 'm1', { scope: 'agent', projectId: p, agentId: rs, title: 'Research timeouts', content: 'Queue-system research tends to run long; give it a narrower question.', tags: ['fixture'], pinned: false, source: 'agent', createdAt: BASE + 18 * 60_000, updatedAt: BASE + 18 * 60_000 });
  message(s, { projectId: p, conversationId: conv, authorType: 'user', content: command, clientId: 'fixture-research-1' });
  message(s, { projectId: p, conversationId: conv, taskId: task, agentId: cto, authorType: 'agent', content: 'Delegation: CTO → Researcher (3 angles in parallel, then a synthesis)' });
  message(s, { projectId: p, conversationId: conv, taskId: task, agentId: rs, authorType: 'agent', content: answer });
  const te = (type, payload, extra) => s.taskEvent(task, p, type, payload, extra);
  te('task.created', { command });
  te('task.classified', { kind: 'research' });
  te('plan.created', { version: 1, subtasks: 4, strategy: 'dag', fanout: 3 });
  for (const a of angles) te('subtask.started', {}, { subtaskKey: a.key, agentId: rs, seconds: 1 });
  for (const a of angles) {
    if (a.ok) te('subtask.completed', {}, { subtaskKey: a.key, agentId: rs });
    else {
      te('subtask.timeout', { attempt: 1 }, { subtaskKey: a.key, agentId: rs, level: 'warn' });
      te('subtask.failed', { error: a.err }, { subtaskKey: a.key, agentId: rs, level: 'error' });
    }
  }
  te('subtask.started', {}, { subtaskKey: 'synth', agentId: rs });
  te('subtask.completed', { missingAngles: ['ra-2'] }, { subtaskKey: 'synth', agentId: rs });
  te('task.completed', { summary: 'Answered from 2 of 3 angles' });
  s.agentEvent({ projectId: p, conversationId: conv, taskId: task, type: 'task.completed', payload: { status: 'done' } });
  s.anchorAt(BASE + 19 * 60_000);
  return s.done();
}

/** 8. A direct OpenCode thread, idle after one turn. */
function directIdle() {
  const s = builder('direct-idle', {
    title: 'Direct OpenCode thread (idle)',
    description: 'A direct thread run by Frontend through OpenCode ACP: one finished turn with reasoning, a read, an edit diff and a test run, now idle.',
    covers: ['tasks (mode direct)', 'taskEvents (threadbear protocol names)'],
  });
  const fe = s.agent('frontend');
  const p = project(s, 'Direct thread', { agentIds: [fe] });
  const task = s.ref('tasks', 'main');
  const ev = (type, payload, extra = {}) => s.taskEvent(task, p, type, payload, extra);
  const startedAt = s.tick();
  ev('thread.created', { mode: 'direct', role: 'frontend', agentId: fe });
  const msgSeq = ev('user.message', { text: 'The header logo is blurry on retina screens. Can you fix it?', clientId: 'fixture-direct-1' }, { eventKey: 'user.message:fixture-direct-1' });
  ev('turn.started', { turnId: 'turn_1', messageSeq: msgSeq }, { eventKey: 'turn.started:turn_1' });
  ev('reasoning', { itemId: 'r1', text: 'The logo is probably a 1x PNG. Check how Header renders it.' });
  ev('tool.call', { itemId: 'c1', name: 'read', kind: 'read', title: 'Read src/components/Header.tsx', input: { path: 'src/components/Header.tsx' } });
  ev('tool.result', { itemId: 'c1', ok: true, text: '<img src="/logo.png" width={120} height={32} alt="Acme" />', truncated: false });
  ev('tool.call', { itemId: 'c2', name: 'edit', kind: 'edit', title: 'Edit src/components/Header.tsx', input: { path: 'src/components/Header.tsx' } });
  ev('edit.diff', { itemId: 'c2', path: 'src/components/Header.tsx', hunks: [{ oldStart: 12, oldLines: 1, newStart: 12, newLines: 1, lines: ['-<img src="/logo.png" width={120} height={32} alt="Acme" />', '+<img src="/logo.svg" width={120} height={32} alt="Acme" />'] }] });
  ev('tool.result', { itemId: 'c2', ok: true, text: 'Edited src/components/Header.tsx', truncated: false });
  ev('tool.call', { itemId: 'c3', name: 'bash', kind: 'command', title: 'npm run test -- Header', input: { command: 'npm run test -- Header' } });
  ev('tool.result', { itemId: 'c3', ok: true, text: 'PASS src/components/Header.test.tsx\nTests: 3 passed, 3 total', truncated: false });
  ev('assistant.text', { itemId: 'm1', text: 'The header used a 1x PNG. It now loads `/logo.svg`, which stays sharp at any density. The Header tests pass.' });
  const done = ev('turn.completed', { turnId: 'turn_1', outcome: 'completed', durationMs: 48_000, answered: 1 }, { eventKey: 'turn.completed:turn_1' });
  s.row('tasks', 'main', {
    projectId: p, title: 'Blurry header logo', command: 'The header logo is blurry on retina screens. Can you fix it?', status: 'waiting_input', mode: 'direct',
    direct: { role: 'frontend', agentId: fe, sessionId: 'ses_fixture_direct_1', engine: 'opencode-acp', status: 'idle', lastSeq: done, deliveredSeq: msgSeq, idleSince: s.now() },
    assignedAgentIds: [fe], permissionMode: 'supervised', idempotencyKey: 'direct:fixture:direct-idle', startedAt, updatedAt: s.now(), eventSequence: 0,
  });
  return s.done();
}

// ------------------------------------------------------------------ write

export function buildAll() {
  msgCount = 0;
  return [plannedPush(), commandApproval(), heldResume(), verifyLoopFailed(), personalChat(), researchFanout(), directIdle()];
}

function write() {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const all = buildAll();
  for (const { scenario, events } of all) {
    const dir = path.join(root, scenario.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'events.ndjson'), events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  }
  const index = {
    $comment: 'Generated by scripts/fixtures/make-synthetic.mjs. Do not edit; run npm run fixtures:make.',
    format: FORMAT,
    base: BASE,
    // The designer show_options review is skipped: no show_options in the schema at this head.
    scenarios: all.map(({ scenario, events }) => ({ id: scenario.id, title: scenario.title, events: events.length })),
  };
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log(`wrote ${all.length} scenarios to ${path.relative(process.cwd(), root) || root}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) write();
