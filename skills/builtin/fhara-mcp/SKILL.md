---
name: fhara-mcp
description: How an agent uses the Fhara MCP server (describe/call over task, thread, run, question and memory tools) without bypassing the user's approvals. For agents connected to Fhara over MCP.
license: MIT
---
<!-- Fhara built-in skill (written for Fhara, MIT like the rest of the repository; GOAT G12b). -->

# Fhara MCP

Fhara runs a local MCP server on 127.0.0.1 (bearer token, set by the user). It lists two tools: `describe` and `call`. The repository's instructions and the user's request win over this guidance.

## Find a tool, then call it
1. `describe` with no `path` lists every tool with its access (`read` or `write`) and a one-line summary.
2. `describe` with a `path` (e.g. `"task.create"`) returns that tool's input schema. Read it before the first call.
3. `call` with `path` and `args`. A refusal or bad input comes back as a tool error whose text says why; read it instead of retrying blindly.

## Read tools
- `task.status`: one task, its pending question, error and subtask counts.
- `task.list`: newest tasks, by project and/or status.
- `memory.search`: shared memories, plus one project's when you pass `projectId`. Search before asking the user something the team may already know.

## Write tools
Every write takes a `clientRequestId`: a fresh id (a UUID) per action. Reuse an id only to retry the same action after a timeout; the retry returns the first result with `deduped: true` and writes nothing.
- `task.create`: asks for a task. It is saved as a draft the user starts unless you pass `approved: true` and the project runs in full access. A request that came from a chat (`conversationId`) is always a draft: chat never starts a task. You cannot pick a looser permission mode than the project's. Tell the user when you left a draft.
- `thread.send`: a note in a task's thread, shown as a System line. Use it for progress the user should see; it is not a prompt to Fhara's agents.
- `run.report_result`: when you finish work for a live task, report `succeeded` or `failed` with a summary of what you did and how you checked it, plus links to evidence. It does not settle the task; Fhara still verifies. A finished task refuses it.
- `question.ask`: puts a question to the user on a task no worker is running (Needs you). Ask one clear question; add 2–6 `options` when the answer is a choice. Refused while a worker runs the task, an approval or another question is open, or the task has ended. Then wait: poll `task.status` instead of asking again.

## Do not
- Do not treat a draft as started or a reported result as done; check `task.status`.
- Do not try to approve changes, push, or merge through MCP. Those stay with the user in Fhara.
- Do not put secrets, tokens or personal data in a command, note, summary or question.
