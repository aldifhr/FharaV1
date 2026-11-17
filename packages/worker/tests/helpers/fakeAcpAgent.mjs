// Minimal fake ACP agent for worker tests (plan 058 step 3).
// Speaks the ACP v1 JSON-RPC-over-stdio surface that effect-acp's client
// drives: initialize, session/new, session/prompt, session/update
// notifications, plus client requests (session/request_permission,
// fs/read_text_file, fs/write_text_file) that the test scenarios trigger.
// This file is spawned by vitest; it is not imported.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");
const nextId = (() => {
  let id = 1000;
  return () => id++;
})();

/** Send a request to the client and wait for its response. */
function clientRequest(method, params) {
  return new Promise((resolve) => {
    const id = nextId();
    const handler = (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message?.id === id && (message.result !== undefined || message.error !== undefined)) {
        rl.off("line", handler);
        resolve(message);
      }
    };
    rl.on("line", handler);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

async function runPrompt(sessionId, promptText) {
  // Report the requested permission scenario and honor the client's answer.
  if (promptText.includes("PERM:")) {
    const response = await clientRequest("session/request_permission", {
      sessionId,
      title: "Run command",
      options: [
        { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
        { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
      ],
      subject: { type: "command", command: "npm run test", cwd: process.cwd() },
    });
    const outcome = response?.result?.outcome ?? response?.error ?? {};
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `perm outcome: ${JSON.stringify(outcome)}` },
        },
      },
    });
  }
  if (promptText.includes("READFILE:")) {
    const target = promptText.split("READFILE:")[1]?.trim() ?? "";
    const response = await clientRequest("fs/read_text_file", { sessionId, path: target });
    const text = response?.result?.content ?? `error: ${JSON.stringify(response?.error ?? {})}`;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `read result: ${text}` },
        },
      },
    });
  }
  if (promptText.includes("WRITEFILE:")) {
    const target = promptText.split("WRITEFILE:")[1]?.trim() ?? "";
    const response = await clientRequest("fs/write_text_file", {
      sessionId,
      path: target,
      content: "written by fake agent\n",
    });
    const ok = response?.result !== undefined;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: ok ? "write ok" : `write error: ${JSON.stringify(response?.error ?? {})}` },
        },
      },
    });
  }
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Pong" },
      },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
        usage: { totalTokens: 21, inputTokens: 10, outputTokens: 5, cachedReadTokens: 4, thoughtTokens: 2 },
      },
    },
  });
}

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message?.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (message?.method === "authenticate") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message?.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fake-1" } });
    return;
  }
  if (message?.method === "session/prompt") {
    // v1 resolves session/prompt on the RPC response, so the update
    // notifications must be flushed BEFORE the reply: the client resolves
    // the prompt call as soon as the response lands and stops reading.
    const text = (message.params?.prompt ?? [])
      .map((block) => (block?.type === "text" ? block.text : ""))
      .join(" ");
    const sessionId = message.params?.sessionId ?? "fake-1";
    void runPrompt(sessionId, text).then(() => {
      setTimeout(() => {
        send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }, 150);
    });
    return;
  }
  // Unknown agent-side methods: answer with an empty result.
  if (message?.id !== undefined && message?.method) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
