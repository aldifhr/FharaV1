/**
 * Chat LLM prompt text: system prompts and guidance lines for the chat
 * reply loop, the CTO's task assignment, the ASK responder chooser and the
 * intent classifier. Builders only — the wording is the product's prompt
 * contract, so change it here deliberately and nowhere else.
 */
import type { IntentSubtype } from "../chat/intent";
import { MAX_CTO_HANDOFFS } from "../chat/team";

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

/** Opening lines of a chat-loop reply: identity, persona, repo grounding. */
export function buildChatPersonaLines(
  agent: Persona,
  projectName: string,
  participants: Array<{ name: string; role: string }>,
  repoSnapshot: string | null
): string[] {
  const multiNotice = participants.length > 1
    ? ` You are participating in a multi-agent discussion with: ${participants.map((a) => `${a.name} (${a.role})`).join(", ")}.`
    : "";
  return [
    `You are ${agent.name}, a ${agent.role} on the agent team of project "${projectName}".${multiNotice}`,
    NOT_THE_MODEL,
    agent.systemPrompt ?? "",
    // Library skills right after the static persona prompt.
    agent.skillsSection ?? "",
    // Pinned memories after the skills (still ahead of per-turn context).
    agent.memorySection ?? "",
    repoSnapshot
      ? `Your chat replies are grounded in this repo snapshot (read-only, provided by the host):\n${repoSnapshot}\nYou still cannot run commands or read other files; for anything deeper, ask the user to Create a task.`
      : "",
  ];
}

/** Line for a teammate the CTO pulled into the chat by @mention. */
export function buildHandoffNotice(ctoName: string): string {
  return `${ctoName} (CTO) brought you into this chat with an @mention. Answer only the part addressed to you, briefly, in the user's language. Do not repeat what the CTO already said.`;
}

/** The transcript appended to the system prompt, in turn order. */
export function buildConversationContext(conversation: Array<{ role: string; content: string }>): string {
  return conversation.length > 0
    ? `Conversation so far (follow this order):\n${conversation.map((m) => `${m.role}: ${m.content.slice(0, 500)}`).join("\n")}`
    : "";
}

export function buildPlanningGuidance(agent: { role: string }, opts: { isOrchestrator: boolean; taskIntent: { kind: string; frontend: boolean; backend: boolean; testing: boolean; security: boolean } }): string[] {
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
    ];
  }
  return [
    "Answer the user's chat message helpfully and completely from your perspective in the same language as the user.",
    "You can answer structural questions (architecture, folders, features) from the repo snapshot given when present — cite actual paths you see there. You still cannot run commands, modify files, or read beyond the snapshot.",
    "For anything that needs workspace access (audit, review, run code), tell the user to Create task so the worker (which CAN read the workspace) can do it.",
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
      return ["Give a read-only audit: findings with severity and file refs. Do not modify anything."];
    default:
      return [];
  }
}

/** System-prompt lines that let the CTO hand parts of a chat turn to teammates. */
export function buildHandoffGuidance(team: Array<{ _id: string; name: string; role: string }>, speakerId: string): string[] {
  const others = team.filter((a) => String(a._id) !== String(speakerId));
  if (others.length === 0) return [];
  return [
    `Teammates you can bring into this chat: ${others.map((a) => `@${a.name}`).join(", ")}.`,
    `When part of the question needs a teammate's expertise, address them with @Name and say exactly what you need from them (at most ${MAX_CTO_HANDOFFS}). They reply right after you, in this chat. Do not mention teammates for greetings or when you can answer fully yourself.`,
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
