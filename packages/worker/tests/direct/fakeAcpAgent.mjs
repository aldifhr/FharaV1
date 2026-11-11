#!/usr/bin/env node
// A fake ACP agent for the direct-thread tests: newline JSON-RPC over stdio,
// shaped like `opencode acp` 1.19.5 (recorded against it on 11 Nov 2026:
// numbered requests from 0, a pending tool_call with empty rawInput, then
// request_permission carrying the diff, then the update with the result).
//
// What it does is chosen by the prompt's last text block:
//   "edit <file>"  asks to write <file>; on allow writes it and reports a diff
//   "run <cmd>"    asks to run a command
//   "run-noopt <cmd>" the same, but offers only the "always" kinds (no plain
//                  allow_once/reject_once), so Fhara must answer cancelled
//   "slow"         answers after 400 ms
//   "wait-cancel"  holds the turn until session/cancel, then stopReason cancelled
//   "hang"         holds the turn forever and ignores session/cancel
//   "die-secret"   streams a key split over chunks, writes it to stderr, exits 3
//   "silent"       sends nothing until session/cancel, then stopReason cancelled
//   "heartbeat"    only usage_update frames (every FAKE_ACP_HEARTBEAT_MS, default
//                  50 ms) until session/cancel, then stopReason cancelled
//   "heartbeat-hang" heartbeats forever and ignores session/cancel
//   anything else  echoes the whole prompt text
// FAKE_ACP_KNOWN_SESSION: the only id session/resume accepts.
// FAKE_ACP_RESUME_HANG: a file path; while it exists, session/resume never answers.
import fs from "node:fs";
import path from "node:path";

let buf = "";
let nextId = 0;
const pending = new Map();
const sessions = new Set([process.env.FAKE_ACP_KNOWN_SESSION ?? "ses_known"]);
let cancelWaiter = null;
let n = 0;

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const notify = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const blocks = params.prompt ?? [];
  const all = blocks.map((b) => b.text ?? "").join("\n");
  const text = (blocks[blocks.length - 1]?.text ?? "").trim();
  const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
  if (text.startsWith("edit ")) {
    const file = path.resolve(process.cwd(), text.slice(5).trim());
    const callId = `call-${++n}`;
    notify(sessionId, { sessionUpdate: "tool_call", toolCallId: callId, title: "write", kind: "edit", status: "pending", locations: [], rawInput: {} });
    const diff = { type: "diff", path: file, oldText: "", newText: "hi\n" };
    const answer = await ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: callId, title: file, kind: "edit", status: "pending", locations: [{ path: file }], rawInput: { filepath: file, diff: "+hi" }, content: [diff] },
      options: [
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "always", kind: "allow_always", name: "Always allow" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    });
    const allowed = answer?.outcome?.outcome === "selected" && answer.outcome.optionId === "once";
    if (answer?.outcome?.outcome === "cancelled") {
      notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "failed", kind: "edit", content: [{ type: "content", content: { type: "text", text: "cancelled" } }] });
      return send({ id, result: { stopReason: "cancelled" } });
    }
    if (allowed) fs.writeFileSync(file, "hi\n");
    notify(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: callId,
      status: allowed ? "completed" : "failed",
      kind: "edit",
      title: "write",
      locations: [{ path: file }],
      rawInput: { filePath: file, content: "hi\n" },
      content: allowed ? [diff, { type: "content", content: { type: "text", text: "Wrote file successfully." } }] : [{ type: "content", content: { type: "text", text: "The user rejected permission to use this specific tool call." } }],
    });
    notify(sessionId, { sessionUpdate: "agent_message_chunk", messageId: `m${n}`, content: { type: "text", text: allowed ? "Done" : "Not" } });
    notify(sessionId, { sessionUpdate: "agent_message_chunk", messageId: `m${n}`, content: { type: "text", text: allowed ? " editing." : " allowed." } });
    return send({ id, result: { stopReason: "end_turn", usage } });
  }
  if (text.startsWith("run ") || text.startsWith("run-noopt ")) {
    const noopt = text.startsWith("run-noopt ");
    const command = text.slice(noopt ? 10 : 4).trim();
    const callId = `call-${++n}`;
    notify(sessionId, { sessionUpdate: "tool_call", toolCallId: callId, title: "bash", kind: "execute", status: "pending", locations: [], rawInput: {} });
    const answer = await ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: callId, title: command, kind: "execute", status: "pending", locations: [], rawInput: { command } },
      options: noopt
        ? [
            { optionId: "always", kind: "allow_always", name: "Always allow" },
            { optionId: "never", kind: "reject_always", name: "Always reject" },
          ]
        : [
            { optionId: "once", kind: "allow_once", name: "Allow once" },
            { optionId: "reject", kind: "reject_once", name: "Reject" },
          ],
    });
    const allowed = answer?.outcome?.outcome === "selected" && answer.outcome.optionId === "once";
    notify(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: callId,
      status: allowed ? "completed" : "failed",
      kind: "execute",
      rawInput: { command },
      content: [{ type: "content", content: { type: "text", text: allowed ? `ran ${command}` : "rejected" } }],
    });
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: allowed ? "ran it" : `did not run (${answer?.outcome?.outcome}${answer?.outcome?.optionId ? `:${answer.outcome.optionId}` : ""})` } });
    return send({ id, result: { stopReason: answer?.outcome?.outcome === "cancelled" ? "cancelled" : "end_turn", usage } });
  }
  if (text === "slow") {
    await sleep(400);
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "slow done" } });
    return send({ id, result: { stopReason: "end_turn", usage } });
  }
  if (text === "wait-cancel") {
    await new Promise((resolve) => (cancelWaiter = resolve));
    return send({ id, result: { stopReason: "cancelled" } });
  }
  if (text === "hang") return; // never answers, ignores session/cancel
  if (text === "silent") {
    await new Promise((resolve) => (cancelWaiter = resolve));
    return send({ id, result: { stopReason: "cancelled" } });
  }
  if (text === "heartbeat" || text === "heartbeat-hang") {
    const every = Number(process.env.FAKE_ACP_HEARTBEAT_MS ?? 50);
    const beat = setInterval(() => notify(sessionId, { sessionUpdate: "usage_update", used: 1, size: 100 }), every);
    if (text === "heartbeat-hang") return; // beats until killed
    await new Promise((resolve) => (cancelWaiter = resolve));
    clearInterval(beat);
    return send({ id, result: { stopReason: "cancelled" } });
  }
  if (text === "die-secret") {
    // Streams a key split over three chunks, then dies with secrets on stderr.
    const key = process.env.FAKE_ACP_SECRET ?? "sk-proj-FAKEsecretKEY0123456789abcdef";
    const mid = `e${++n}`;
    for (const part of ["Using key ", key.slice(0, 6), key.slice(6, 20), key.slice(20), " now"]) {
      notify(sessionId, { sessionUpdate: "agent_message_chunk", messageId: mid, content: { type: "text", text: part } });
      await sleep(30);
    }
    fs.writeSync(2, `Error: request failed with OPENAI_API_KEY=${key}\n`);
    fs.writeSync(2, `fatal: Authorization: Bearer ${key}\n`);
    fs.writeSync(2, "Error: provider returned 500\n");
    fs.writeSync(2, "loading plugins\n");
    await sleep(50);
    process.exit(3);
  }
  notify(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
  notify(sessionId, { sessionUpdate: "agent_message_chunk", messageId: `e${++n}`, content: { type: "text", text: `Echo: ${all}` } });
  send({ id, result: { stopReason: "end_turn", usage } });
}

function onMessage(msg) {
  if (msg.method && msg.id !== undefined) {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        return send({
          id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, promptCapabilities: { image: false }, sessionCapabilities: { resume: {}, close: {} } },
            authMethods: [{ id: "opencode-login", name: "Login with opencode" }],
            agentInfo: { name: "OpenCode", version: "fake" },
          },
        });
      case "session/new": {
        const sessionId = `ses_fake_${process.pid}_${++n}`;
        sessions.add(sessionId);
        return send({ id, result: { sessionId, configOptions: [{ id: "model", category: "model", currentValue: "opencode/fake" }] } });
      }
      case "session/resume":
        if (process.env.FAKE_ACP_RESUME_HANG && fs.existsSync(process.env.FAKE_ACP_RESUME_HANG)) return;
        if (!sessions.has(params.sessionId)) return send({ id, error: { code: -32002, message: `Session not found: ${params.sessionId}` } });
        return send({ id, result: { configOptions: [] } });
      case "session/set_config_option":
        return send({ id, result: { configOptions: [{ id: "model", category: "model", currentValue: params.value }] } });
      case "session/prompt":
        return void prompt(id, params);
      default:
        return send({ id, error: { code: -32601, message: `no ${method}` } });
    }
  }
  if (msg.method === "session/cancel") {
    cancelWaiter?.();
    cancelWaiter = null;
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result ?? null);
  }
}

process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) onMessage(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
