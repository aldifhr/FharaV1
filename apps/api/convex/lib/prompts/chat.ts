/**
 * Chat LLM prompt text: system prompts and guidance lines for the chat
 * reply loop, the CTO's task assignment, the ASK responder chooser and the
 * intent classifier. Builders only — the wording is the product's prompt
 * contract, so change it here deliberately and nowhere else.
 */
import type { IntentSubtype } from "../chat/intent";
import { WRAP_UP_MAX_LINES } from "../chat/wrapUp";
import { isHandoffLine } from "../chat/dispatch";
import { LOAD_SKILL_MAX_CALLS, LOAD_SKILL_TOOL } from "../skills";
import { LOAD_SKILL_TOOL_LINE } from "../skillRuntime";
import { LEGACY_ROLE_SUCCESSORS, isRoleKey, normalizeRoleKey, roleChatSummary } from "../roles";
import { AGENT_SEED_PROMPTS, GENERIC_AGENT_PROMPT, LEGACY_UI_UX_PROMPT, PREVIOUS_SEED_PROMPTS } from "./agents";

type Persona = { name: string; role: string; systemPrompt?: string; skillsSection?: string; memorySection?: string };

/** Clip user text quoted into a classifier/chooser prompt. */
function clip500(text: string): string {
  return text.length > 500 ? text.slice(0, 500) + "..." : text;
}

/** Shared identity line: agents answer as their role, never as the model. */
const NOT_THE_MODEL =
  "You are NOT the underlying LLM model. Never name the model (e.g. \"Crouton Alpha\") or claim to be the provider — always answer as your assigned role.";

/** CTO chooser: pick the one teammate who best answers an ASK. */
export const ASK_RESPONDER_SYSTEM = "Pick one conversational agent. Return JSON only.";

export function buildAskResponderPrompt(
  candidates: Array<{ _id: string; name: string; role: string; systemPrompt?: string }>,
  userText: string
): string {
  const pool = candidates
    .map((a, i) => `${i + 1}. ${a.name} (${a.role}): ${(a.systemPrompt ?? "").slice(0, 120)} [id ${a._id}]`)
    .join("\n");
  return [
    "You are the CTO picking which single teammate best answers this chat question. Choose the role whose expertise matches the question topic (e.g. styling/UI → Frontend, security/audit → Reviewer, server/deploy → DevOps/Backend).",
    "Return ONLY JSON with this exact schema:",
    `{"agentId":"<id from [id ...]>"}`,
    "",
    `Candidates:\n${pool}`,
    "",
    `Question: ${clip500(userText)}`,
  ].join("\n");
}

/** Stage B intent classifier. */
export const INTENT_CLASSIFIER_SYSTEM = "Classify intent. Return JSON only.";

export function buildIntentClassifierPrompt(
  text: string,
  activeTask?: { title: string; status: string } | null
): string {
  return [
    "You are an intent classifier for a software engineering workspace.",
    "Return ONLY JSON with this exact schema:",
    `{"intent":"ask"|"task","subtype":"explanation"|"recommendation"|"research"|"audit"|"implementation"|"debugging"|"testing"|"other","requiresWorkspace":bool,"requiresExecution":bool,"target":"?","confidence":0..1,"reasoning":"..."}`,
    "",
    "Choose `task` when the user wants the AI team to DO work (build, fix, test, refactor, migrate). Choose `ask` for pure questions/discussion. Subtypes: explanation/recommendation/research/audit ask; implementation/debugging/testing task.",
    "",
    "The text may be Indonesian, English, mixed, or informal. Judge by meaning, not by word list.",
    "",
    `User text: ${clip500(text)}`,
    activeTask ? `Active task: ${activeTask.title} [${activeTask.status}]` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Greeting fast path: one short in-persona hello, minimal context. */
export function buildGreetingSystem(agent: Persona, projectName: string): string {
  return [
    `You are ${agent.name}, a ${agent.role} on the agent team of project "${projectName}".`,
    NOT_THE_MODEL,
    agent.systemPrompt ?? "",
    "Greet the user briefly in your own persona, same language as the user. One short sentence, no plan, no delegation, no Create task instructions.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The CTO's assignment reply when a chat message becomes a task. */
export function buildCtoAssignmentSystem(
  orchestrator: Persona & { _id: string },
  projectName: string,
  team: Array<{ _id: string; name: string; role: string }>,
  requested: Array<{ name: string }>
): string {
  return [
    `You are ${orchestrator.name}, the CTO of project "${projectName}".`,
    "You are NOT the underlying LLM model. Never name the model or the provider.",
    // The CTO persona prompt (read-only advisor, long technical answers) is
    // left out on purpose: here the task already exists and this bubble is
    // only the hand-off. With the persona in, the CTO answered the request
    // itself (code, risks, "I'm read-only", "@Frontend please create the task").
    ...buildAssignmentGuidance(team, String(orchestrator._id), requested),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Several agents answer one message (the user @mentioned them, or the CTO
 * pulled them in): each posts its own reply. Night e2e: with @Frontend
 * @Backend @QA, Frontend answered for all three, then they answered again.
 */
export function buildSeparateSpeakersLine(
  agent: { name: string; role: string },
  participants: Array<{ name: string; role: string }>
): string {
  const others = participants.filter((a) => a.name !== agent.name);
  if (others.length === 0) return "";
  const list = others.map((a) => `${a.name} (${a.role})`).join(", ");
  return [
    `Other teammates answer this message separately, each in their own reply: ${list}.`,
    `Answer only as yourself (${agent.name}, ${agent.role}), from your own role. Never answer for them, speak for them, guess what they will say, or write sections or lines labelled with their names.`,
  ].join(" ");
}

/** Opening lines of a chat-loop reply: identity, persona, repo grounding. */
export function buildChatPersonaLines(
  agent: Persona,
  projectName: string,
  participants: Array<{ name: string; role: string }>,
  repoSnapshot: string | null,
  repoTools = false
): string[] {
  return [
    `You are ${agent.name}, a ${agent.role} on the agent team of project "${projectName}".`,
    buildSeparateSpeakersLine(agent, participants),
    NOT_THE_MODEL,
    agent.systemPrompt ?? "",
    // Library skills right after the static persona prompt.
    agent.skillsSection ?? "",
    // Pinned memories after the skills (still ahead of per-turn context).
    agent.memorySection ?? "",
    repoSnapshot
      ? repoTools
        ? `Repo snapshot (read-only, provided by the host):\n${repoSnapshot}\nRead deeper with the repo tools described below.`
        : `Your chat replies are grounded in this repo snapshot (read-only, provided by the host):\n${repoSnapshot}\nYou still cannot run commands or read other files; for anything deeper, ask the user to Create a task.`
      : "",
  ];
}

/**
 * Read-only repo tool protocol for one chat reply (the CTO, its handoff
 * teammates, or @mentioned agents, when a worker can serve the tools). The loop in lib/chat/repoTools.ts parses the calls.
 */
export function buildRepoToolProtocol(maxCalls: number, opts: { loadSkill?: boolean } = {}): string {
  return [
    "## Repo tools (read-only)",
    "You can read the project repository before answering. To call a tool, reply with ONLY one JSON object and nothing else — one call per reply, then wait for its result. E.g.:",
    '{"tool":"grep","arguments":{"pattern":"replyToChat"}}',
    "Tools:",
    '- list_files {"path"?: dir, "glob"?: e.g. "**/*.ts"}: files with sizes in bytes (no node_modules, .git, .env*).',
    '- grep {"pattern": regex, "path"?: dir or file, "glob"?: file filter, "ignoreCase"?: bool}: the total match count, then matching lines as path:line: text (first 40). Omit "path" to search the whole repository — do that to locate a symbol.',
    '- read_file {"path": file, "start"?: line, "lines"?: count}: numbered lines with the file\'s total lines and size; at most 400 lines (16 KB) per read.',
    ...(opts.loadSkill ? [LOAD_SKILL_TOOL_LINE, `(${LOAD_SKILL_TOOL} has its own limit of ${LOAD_SKILL_MAX_CALLS} per reply and does not use the repo tool budget.)`] : []),
    `At most ${maxCalls} ${opts.loadSkill ? "repo " : ""}tool calls per reply. You cannot write files or run commands. The result comes back as the next message; then call another tool or write your answer as plain prose (never JSON, never a tool call inside the answer).`,
    "Rules for the answer:",
    '- A read_file result marked "truncated: lines X-Y of N" showed only that part. Never state a count or a list for the whole file from a part: read the next page with "start", or grep it (e.g. {"tool":"grep","arguments":{"pattern":"defineTable","path":"apps/api/convex/schema.ts"}}) and use grep\'s match count.',
    '- A grep with "0 matches" means not found: say it was not found (Indonesian: "tidak ketemu"), never guess another file or line. If it searched a subfolder, grep the whole repository before saying it does not exist.',
    "- Cite a file:line only exactly as a tool result in this reply shows it, and a path only if a tool result or the snapshot shows it. Anything else you did not check: say \"belum saya cek\".",
  ].join("\n");
}

/**
 * Grounding rule for chat replies: claims about the repo come from a tool
 * result (or the snapshot) in this reply, never from memory or from what the
 * user pasted. Without tools the agent says it has not checked.
 */
/**
 * On-demand skills without repo tools: the one local tool the agent may
 * call is load_skill (same JSON protocol as the repo tools).
 */
export function buildSkillToolProtocol(): string {
  return [
    "## Skill tool (read-only)",
    `Your skills are listed above by name only. To read one, reply with ONLY one JSON object and nothing else, e.g. {"tool":"${LOAD_SKILL_TOOL}","arguments":{"name":"<skill name>"}}, then wait for its text.`,
    LOAD_SKILL_TOOL_LINE,
    `Load a skill only when it bears on this reply; at most ${LOAD_SKILL_MAX_CALLS} per reply. Then write your answer as plain prose (never JSON).`,
  ].join("\n");
}

export function buildGroundingGuidance(hasRepoTools: boolean, hasSkillTool = false): string[] {
  return [
    "Grounding rule: any claim about this repo's code, files, file sizes, line counts, or which agent/module does what must come from a tool result in this reply" +
      " (or the repo snapshot above). A number or quote the user pasted is a claim to verify, not a fact.",
    hasRepoTools
      ? "Check with the repo tools before stating such a claim. If you did not check something, say so plainly in the user's language (Indonesian: \"belum saya cek\"; English: \"I haven't checked that yet\") instead of guessing. Report not-found as not-found, and never cite a file:line that is not in a tool result in this reply."
      : (hasSkillTool
          ? `You have no repo access in this reply: the only tool you may call is ${LOAD_SKILL_TOOL}.`
          : "You have no repo access and no tools in this reply: never output a tool call or JSON.") + " Do not state code, file, size, line-number, or ownership facts that are not in the snapshot; say you have not checked them yet in the user's language (Indonesian: \"belum saya cek\"; English: \"I haven't checked that yet\").",
    hasRepoTools
      ? "When the user pushes back or contradicts you about the code, re-check with the tools and answer from what you find: keep your answer if the code supports it, correct it if not. Never agree just because the user said so."
      : "When the user pushes back about the code, do not simply agree: say what you can and cannot confirm without checking.",
  ];
}

/**
 * "baca ulang" / "cek lagi" / "koreksi": the user asks the agent to re-read
 * and correct its OWN previous reply. Quoted here so it is in context even
 * when the history window is short, and so the model does not read the
 * request as "re-read your skills/instructions".
 */
export function buildSelfReviewGuidance(previousReply: string | null, hasRepoTools: boolean): string {
  const quoted = previousReply?.trim()
    ? `Your previous reply:\n"""\n${previousReply.trim().slice(0, 4000)}\n"""`
    : "Your previous reply is the last assistant message in the conversation.";
  return [
    "The user's latest message (e.g. \"baca ulang\", \"cek lagi\", \"koreksi\", \"re-read\") asks you to re-read and correct YOUR previous reply — not to re-read your skills, persona, or these instructions.",
    quoted,
    hasRepoTools
      ? "Re-check each factual claim in it with the repo tools, then say which parts were wrong and give the corrected answer (keep what the tools confirm)."
      : "Re-read each claim in it, say which parts you cannot confirm without checking the repo, and correct what is wrong.",
  ].join("\n");
}

/** Line for a teammate the CTO pulled into the chat by @mention. */
export function buildHandoffNotice(ctoName: string, request = ""): string {
  return [
    `${ctoName} (CTO) brought you into this chat with an @mention.`,
    request ? `What the CTO asked you: "${request}"` : "",
    "Answer only that, briefly (2-4 sentences), in the user's language, and only about the user's LATEST message. Do not pick up earlier topics or tasks from the conversation unless the latest message is about them. Do not repeat what the CTO said, do not @mention anyone, and do not tell the user to create a task.",
  ].filter(Boolean).join(" ");
}

/**
 * A specialist the CTO routed the user's question to (dispatch pre-route):
 * it owns the whole answer, unlike a brief @mention handoff.
 */
export function buildRoutedSpecialistNotice(ctoName: string, hasRepoTools: boolean): string {
  return [
    `${ctoName} (CTO) handed the user's latest message to you because it is your area. Answer it fully yourself, in the user's language.`,
    hasRepoTools
      ? "Check the code with the repo tools before you state anything about it, and cite only what a tool result shows."
      : "",
    "Answer only the user's LATEST message. Do not @mention anyone, do not hand the question back, do not repeat the CTO's handoff line, and do not tell the user to create a task unless the question asks for changes to be made.",
  ].filter(Boolean).join(" ");
}

/**
 * The CTO's wrap-up after a routed specialist answered (only for a long
 * reply; see lib/chat/wrapUp.ts). Tool-free; it may only add a decision or
 * next step, never restate the reply.
 */
export function buildCtoSummarySystem(cto: { name: string }, specialist: { name: string; role: string }, projectName: string): string {
  return [
    `You are ${cto.name}, the CTO of the agent team of project "${projectName}". ${NOT_THE_MODEL}`,
    `${specialist.name} (${specialist.role}) just answered the user's question in this chat, and the user has already read that reply. Write a wrap-up of at most ${WRAP_UP_MAX_LINES} lines, in the user's language, plain text.`,
    `It may only add a decision or a next step that follows from ${specialist.name}'s reply below. Do not restate, summarise or paraphrase the reply, and do not repeat any offer or question it ends with. Add no new facts, files, line numbers, code or claims, and do not say you checked anything yourself.`,
    "If there is no decision or next step to add, reply with exactly: nothing to add.",
    "Do not @mention anyone, do not write as or for the teammate, and do not offer an [options] block. No headers, no tool calls.",
  ].join("\n");
}

/** The message the CTO's wrap-up answers: the question and the specialist's reply, quoted. */
export function buildCtoSummaryMessages(question: string, specialist: { name: string }, reply: string): ChatPromptMessage[] {
  return [
    {
      role: "user",
      content: `User's question:\n${question.trim()}\n\n${specialist.name}'s reply:\n${reply.trim()}\n\nWrite the wrap-up now (a decision or next step only, or \"nothing to add\").`,
    },
  ];
}

/** CTO chat conduct: delegate deep work, stay short, never speak for a teammate. */
export const CTO_DELEGATION_GUIDANCE =
  "Keep your own replies short. Deep work (a code audit, a test check, research, a design or security review) belongs to the teammate whose area it is: bring them in with @Name instead of doing it at length yourself. Never write lines as a teammate, speak for them, or invent what they found.";

/** One chat history row as getContext returns it. */
export type ChatHistoryRow = { authorType: string; content: string; agentId?: string };
export type ChatPromptMessage = { role: "user" | "assistant"; content: string };

/** Older turns are clipped; the message being answered never is. */
const OLDER_TURN_MAX_CHARS = 1500;
function clipTurn(text: string): string {
  return text.length > OLDER_TURN_MAX_CHARS ? `${text.slice(0, OLDER_TURN_MAX_CHARS)}…` : text;
}

/** Rule for every chat reply: the bubble already shows who is speaking. */
export const NO_SPEAKER_PREFIX_LINE =
  "Never start your reply with a name, role or speaker label (no \"CTO:\", \"Reviewer:\", \"**Name:**\"): the chat already shows who is speaking. Start directly with the answer.";

/** A teammate's earlier reply, quoted as context without a "Name:" label. */
export function teammateContextBlock(name: string | undefined, text: string): string {
  const who = name?.trim() ? `teammate ${name.trim()}` : "a teammate";
  return `[Earlier reply from ${who}, quoted for context only, not written by you]\n${text}`;
}

/**
 * The chat history as real messages for one agent's reply. The user's
 * latest message (the one this reply answers) is always the LAST message,
 * whole; earlier turns come before it in order, clipped. The agent's own
 * earlier replies are `assistant`; a teammate's are `user` context blocks
 * (teammateContextBlock), never "Name: text" lines. Consecutive older turns of one role are merged
 * and leading agent turns dropped, so the list starts with the user; the
 * latest message is never merged into an earlier one. Nothing here goes into the system prompt (night e2e A5:
 * history serialized inside the tools section made the CTO answer an
 * earlier greeting instead of a pasted multi-line request).
 */
export function buildChatMessages(
  history: ChatHistoryRow[],
  opts: { selfAgentId?: string; nameOf?: (agentId: string | undefined) => string | undefined } = {}
): ChatPromptMessage[] {
  let last = history.length - 1;
  while (last >= 0 && history[last].authorType !== "user") last -= 1;
  const latest = last >= 0 ? history[last].content.trim() : "";
  const older: ChatPromptMessage[] = [];
  let seenUser = false;
  for (const row of history.slice(0, Math.max(0, last))) {
    const text = row.content?.trim();
    if (!text) continue;
    // Agent rows before the first user message (an old turn cut by the
    // window) have nothing to answer: dropped.
    if (row.authorType === "user") seenUser = true;
    else if (!seenUser) continue;
    // The CTO's fixed handoff line is routing, not content: as a transcript
    // line it got copied into the specialist's reply.
    if (row.authorType === "agent" && isHandoffLine(text)) continue;
    let msg: ChatPromptMessage;
    if (row.authorType === "agent") {
      const self = opts.selfAgentId !== undefined && String(row.agentId ?? "") === String(opts.selfAgentId);
      // A teammate's reply is context, not the agent's own turn and not a
      // "Name: text" transcript line: as `assistant` "CTO: …" rows the model
      // learned that replies open with a name and copied it (live test 4).
      msg = self
        ? { role: "assistant", content: clipTurn(text) }
        : { role: "user", content: teammateContextBlock(opts.nameOf?.(row.agentId), clipTurn(text)) };
    } else {
      msg = { role: "user", content: clipTurn(text) };
    }
    const prev = older[older.length - 1];
    if (prev && prev.role === msg.role) prev.content = `${prev.content}\n\n${msg.content}`;
    else older.push(msg);
  }
  while (older.length && older[0].role === "assistant") older.shift();
  return latest ? [...older, { role: "user", content: latest }] : older;
}

/**
 * System-prompt section with the turn's own context: the compacted summary
 * of older chat, the message the user quoted, and the replies teammates
 * already posted in this turn. Ends with which message to answer.
 */
export function buildTurnContextSection(opts: {
  summary?: string;
  quoteLine?: string;
  turnReplies?: Array<{ name: string; content: string }>;
}): string {
  const lines: string[] = ["## This turn"];
  if (opts.summary?.trim()) lines.push(`Summary of the earlier conversation: ${opts.summary.trim()}`);
  if (opts.quoteLine?.trim()) lines.push(opts.quoteLine.trim());
  if (opts.turnReplies?.length) {
    lines.push(
      "Teammates already replied to this message (their words, not yours; do not repeat them):",
      ...opts.turnReplies.map((r) => `<teammate_reply from="${r.name.replace(/"/g, "")}">\n${clipTurn(r.content.trim())}\n</teammate_reply>`)
    );
  }
  lines.push(NO_SPEAKER_PREFIX_LINE);
  lines.push(
    "Answer the user's LAST message in the conversation, as a whole (it may span several lines, e.g. a pasted spec). Earlier messages are context only: never answer them again (an earlier greeting is not the question now)."
  );
  return lines.join("\n");
}

export function buildPlanningGuidance(agent: { role: string }, opts: { isOrchestrator: boolean; hasRepoTools?: boolean; taskIntent: { kind: string; frontend: boolean; backend: boolean; testing: boolean; security: boolean; runCommands?: string[] } }): string[] {
  const run = opts.taskIntent.runCommands;
  if (opts.isOrchestrator && opts.taskIntent.kind === "task" && run && run.length > 0) {
    const lines = run.map((line) => `\`${line}\``).join(", ");
    return [
      "You are the orchestrator/planner (CTO).",
      `The user asked to run ${lines}. Chat replies cannot run commands, but the team can: a task runs it on the worker after the user allows the command.`,
      "Never say you have no shell or terminal access, and never tell the user to run it themselves.",
      `In 1-2 short sentences in the user's language: say that the Create task button under this reply runs ${lines} (the user approves the command first) and what you will report back. No plan, no bullets, no terminal output, and never claim anything has run.`,
    ];
  }
  if (opts.isOrchestrator && opts.taskIntent.kind === "task") {
    return [
      "You are the orchestrator/planner (CTO).",
      "Propose a brief plan in 2-3 plain-language sentences: what will be done first, who will do each part (delegation), and how you will check it. No bullets, no numbered plan, no terminal output, no headers.",
      "End with one short sentence in plain words: 'To execute this plan, klik Create task — saya akan delegasikan ke agent yang sesuai.'",
      "Do not pretend to have executed code. Detail (files, order, validation, technical steps) lives in the task the worker runs, not in chat.",
    ];
  }
  if (opts.isOrchestrator) {
    return [
      "You are the orchestrator/planner.",
      "Greetings and small talk get a brief greeting back — never a plan, delegation, or mention list for a bare hello.",
      "Answer briefly. If user asks for work to be done, propose a plan + delegation, then tell them to use Create task. Do not pretend to have executed code. Respond in plain text.",
      CTO_DELEGATION_GUIDANCE,
    ];
  }
  return [
    "Answer the user's chat message helpfully and completely from your perspective in the same language as the user.",
    opts.hasRepoTools
      ? "You can read the repository with the read-only repo tools described below — check the code yourself before answering and cite only what a tool result shows. You still cannot run commands or modify files."
      : "You can answer structural questions (architecture, folders, features) from the repo snapshot given when present — cite actual paths you see there. You still cannot run commands, modify files, or read beyond the snapshot.",
    opts.hasRepoTools
      ? "A read-only audit, review or code question is yours to answer here, now, by reading the code with the repo tools: never answer it with a plan or by telling the user to create a task. Only work that changes files or runs code needs a task."
      : "Only when the user asked for work that needs workspace access (audit, review, run code) say that it needs a task; for plain questions never mention creating a task.",
    "Do not pretend to have executed code. Respond in plain text.",
  ];
}

/** Answer Engine guidance per intent subtype (plan 016). */
export function buildAnswerGuidance(subtype: IntentSubtype): string[] {
  switch (subtype) {
    case "explanation":
      return ["Explain completely in the user's language: give the concrete code/config that answers the question, why it fits this project, and cite actual paths from the snapshot when present. For anything needing workspace access beyond the snapshot, tell the user to Create task so the worker (which can read the workspace) can do it."];
    case "recommendation":
      return ["Recommend one concrete option with a brief rationale in the user's language, in prose. No options block, no plan, no delegation, no code unless asked."];
    case "research":
      return ["Answer from evidence: lead with the verdict, then the concrete details, citing actual paths from the snapshot when present. Show code only when the question is about how to write it. For a comparison, end with your pick in prose, never an options block. No speculation, no execution."];
    case "audit":
      return ["Give a read-only audit: read the code first (with the repo tools when you have them), then findings with severity and file refs. Do not modify anything, and do not answer with a plan or a Create task offer."];
    default:
      return [];
  }
}

/** The CTO verifies repo facts itself when it has tools; teammates are for their specialty. */
export const SELF_VERIFY_LINE =
  "If you have repo tools, verify it yourself in this reply.";

/** Repo access is off for the whole reply: teammates cannot check code either. */
export function noRepoAccessHandoffLine(offReason: string): string {
  return [
    "There is no repo access in this reply, and your teammates have none either: do not @mention teammates to check, verify, or grep code.",
    "Say plainly what is unverified, and suggest restarting the worker or setting the project folder" +
      (offReason ? ` (reason: ${offReason}).` : "."),
  ].join(" ");
}

/** System-prompt lines that let the CTO hand parts of a chat turn to teammates. */
export function buildHandoffGuidance(
  team: Array<{ _id: string; name: string; role: string }>,
  speakerId: string,
  repo: { hasRepoTools: boolean; offReason?: string } = { hasRepoTools: false }
): string[] {
  const others = team.filter((a) => String(a._id) !== String(speakerId));
  if (others.length === 0) return [];
  return [
    `Teammates on this project: ${others.map((a) => `@${a.name}`).join(", ")}.`,
    "Answer the user yourself. Writing @Name in your reply does NOT bring a teammate into this chat: only the user can @mention one. When a teammate's specialty is really needed, say which one (as @Name) and that the user can @mention them; for work that needs running or changing files, offer the Create task button instead. Do not ask the user for permission to bring a teammate in.",
    "When you only describe or list the team (who does what), write their role names WITHOUT @.",
    repo.hasRepoTools ? SELF_VERIFY_LINE : noRepoAccessHandoffLine(repo.offReason ?? ""),
  ];
}

/** System-prompt lines for the CTO when it assigns a task from chat. */
export function buildAssignmentGuidance(
  team: Array<{ _id: string; name: string; role: string }>,
  speakerId: string,
  requested: Array<{ name: string }>
): string[] {
  const others = team.filter((a) => String(a._id) !== String(speakerId));
  return [
    "The user asked the team to do work, and the task is being created now. Reply quickly, without long deliberation.",
    `In one or two short sentences in the user's language, say who does what and address each owner as @Name. Teammates: ${others.map((a) => `@${a.name}`).join(", ")}. Pick only the ones really needed.`,
    requested.length ? `The user asked for ${requested.map((a) => `@${a.name}`).join(", ")}; include them.` : "",
    "Do not tell the user to click Create task and do not claim anything has run.",
    "The task is ALREADY created; the team executes it. Do not solve it yourself: no code, no code blocks, no implementation details, no risk analysis, no mention of being read-only, and never ask anyone to create a task.",
    // The example must not look like a real request: the model copied the
    // old one (a formatRupiah task) word for word whenever it was close.
    "Format: at most 2 sentences, under 40 words, shaped like: \"Siap. @<owner> <their part>, lalu @<checker> <their part>.\" Fill it from THIS request; pick owners by the work (code in the UI: Frontend; API or data: Backend; checks: QA or Reviewer).",
  ].filter(Boolean);
}

/** Shared guidance: machine-readable choice blocks for clickable cards.
 *  Only when the user genuinely needs to pick between alternatives (e.g.
 *  asked for options, a recommendation, or a decision between designs).
 *  Never for capability questions, explanations, greetings, or status. */
export const OPTIONS_GUIDANCE =
  "Only use an options block when the user explicitly asks you to propose alternatives for them to pick from for something you will build (e.g. layout or design directions). Never use it for questions, comparisons, recommendations (\"X vs Y, which fits?\" gets your pick in prose), explanations, greetings, status reports, or task updates — answer those plainly. Format when used, exactly:\n[options]\nA|Short title|One-line summary|layout|Toolbar / Templates + Editor*2 + Preview A4\nB|Short title|One-line summary|layout|Toolbar / Editor\n[/options]\nFor a visual layout, the 4th field is 'layout' and the 5th draws the real wireframe: rows split by ' / ', regions in a row split by ' + ', an optional width weight like 'Editor*2', each region named with the words from your summary (max 4 rows, 4 regions per row, 2-3 words each). Each option's wireframe must match its own summary. Use plain as the 4th field (and no 5th) for anything that is not a visual layout (libraries, approaches, wording). Keep it to ONE block per reply, then stop.\nBase the options on the user's CURRENT request only — do not carry over past tasks, files, or topics from earlier in this conversation unless the user asks for them personally. Keep your reply before the block to one short sentence: no plan summary, no delegation talk, no 'Create task' instructions. A pick is an opinion, not an order — do not start execution yourself.\nWhen the user picks one of your options, reply starting with 'I agree' if you endorse the choice, or explain your objection and why.";

/**
 * Whether `prompt` is still a built-in seed persona (never edited by the
 * user). Seeds are written for task execution in this product's own stack
 * (e.g. "Convex queries/mutations", "Boundaries: no UI work"), so a personal
 * chat with no project swaps an unedited seed for the stack-neutral area.
 */
export function isSeedPersonaPrompt(role: string, prompt: string | undefined): boolean {
  const text = (prompt ?? "").trim();
  if (!text) return false;
  if (text === GENERIC_AGENT_PROMPT || text === LEGACY_UI_UX_PROMPT) return true;
  const raw = normalizeRoleKey(role);
  const key: string = LEGACY_ROLE_SUCCESSORS[raw] ?? raw;
  if (!isRoleKey(key)) return false;
  return text === AGENT_SEED_PROMPTS[key].trim() || (PREVIOUS_SEED_PROMPTS[key] ?? []).some((p) => p.trim() === text);
}

/**
 * Personal mode (no project attached): a private 1:1 chat for
 * brainstorming, technical discussion, learning, questions and general
 * help. Role boundaries govern task work, not conversation; no repo or
 * Attach-project talk unless the user asks about their own code.
 */
export function buildPersonalModeSection(agent: { role: string }, opts: { skillTool?: boolean } = {}): string {
  const area = roleChatSummary(agent.role);
  return [
    "## Personal chat",
    "This is a private one-to-one chat with the user: brainstorming, technical discussion, learning, questions and general help.",
    area ? `Your area as ${agent.role}: ${area}` : "",
    "Help broadly with your area and with general technical questions in any language, framework or stack the user brings up, not only the stack named in your task instructions. Answer directly and naturally, in the user's language.",
    "Your role boundaries limit what you DO in tasks (writing code, running commands), not what you can talk about. Never recite your scope, boundaries or what you are not, unless the user asks what you can't do.",
    "No project, repository or workspace is attached to this chat. Do not mention the repo, attaching a project, or that you have not checked anything, unless the user asks about their own code or files or wants work done on them; then say once, briefly, that attaching a project (Attach project) lets you read it.",
    "If a question is clearly another teammate's specialty, you may name that role (without @) in one short line, and still help as far as you can.",
    opts.skillTool ? "" : "You have no tools in this reply: never output a tool call or JSON.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Personal chat (plan 039): the opening of a one-to-one reply. No project:
 * personal mode (buildPersonalModeSection), with an unedited seed persona
 * swapped for the role's stack-neutral area. Attached: the project's repo
 * snapshot and read-only tools (when available), tasks only through Create
 * task; the caller adds the grounding rule.
 */
export function buildPersonalChatSystem(
  agent: Persona,
  opts: { projectName: string | null; repoSnapshot: string | null; repoTools: boolean; skillTool?: boolean }
): string[] {
  const attached = opts.projectName !== null;
  const persona = !attached && isSeedPersonaPrompt(agent.role, agent.systemPrompt) ? "" : (agent.systemPrompt ?? "");
  return [
    attached
      ? `You are ${agent.name}, a ${agent.role}, in a personal one-to-one chat with the user. This chat is attached to project "${opts.projectName}".`
      : `You are ${agent.name}, a ${agent.role}, in a personal one-to-one chat with the user.`,
    NOT_THE_MODEL,
    persona,
    agent.skillsSection ?? "",
    agent.memorySection ?? "",
    attached
      ? [
          opts.repoSnapshot
            ? opts.repoTools
              ? `Repo snapshot (read-only, provided by the host):\n${opts.repoSnapshot}\nRead deeper with the repo tools described below.`
              : `Repo snapshot (read-only, provided by the host):\n${opts.repoSnapshot}`
            : "",
          "You cannot write files or run commands in this chat. For work on the code, the user can create a task (the Create task button or /task).",
        ]
          .filter(Boolean)
          .join("\n")
      : buildPersonalModeSection(agent, { skillTool: opts.skillTool }),
    attached
      ? "You are the only agent in this chat. Never hand the question to a teammate, @mention teammates to pull them in, or speak for other agents."
      : "You are the only agent in this chat. Never @mention teammates to pull them in or speak for other agents.",
    "Reply in the user's language.",
  ].filter(Boolean);
}
