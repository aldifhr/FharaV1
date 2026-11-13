"use client";

import { roleLabel } from "@/lib/agentRoles";
import type { StatusMap, TeamStatusEntry } from "@/lib/teamStatus";
import type { AgentRef as Agent } from "@/lib/types";

type CheckEvent = { taskId?: string; type: string; payload?: { label?: string; sandbox?: string }; _creationTime: number };

/** D6: how the task's newest shell command ran (from its `shell.command` event). */
const SANDBOX_NOTE: Record<string, string> = {
  sandboxed: "sandboxed",
  off: "sandbox off",
  unconfined: "running unconfined",
  unavailable: "sandbox unavailable",
};

function sandboxNote(events: CheckEvent[] | undefined, taskId: string | null | undefined): string | null {
  if (!taskId) return null;
  const last = (events ?? []).find((e) => e.taskId === taskId && e.type === "shell.command" && typeof e.payload?.sandbox === "string");
  return last ? (SANDBOX_NOTE[last.payload!.sandbox!] ?? null) : null;
}

const ORDER = { testing: 0, reviewing: 1, working: 2 } as const;

function hostPath(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** A task this chat is waiting on: the short ref shown and its id to open. */
export type WaitingTask = { id: string; ref: string };

const WAITING_NAMED = 2;

/**
 * One quiet, centered line above the composer: who is doing what right now
 * ("QA is checking shedi.app at 375 px", "CTO is drafting a reply"), else
 * which open tasks the chat is waiting on.
 */
export default function StatusLine({
  agents,
  status,
  drafting,
  events,
  qaUrl,
  waiting = [],
  onOpenTask,
}: {
  agents: Agent[];
  status?: StatusMap;
  /** Roles drafting a chat reply (no execution lease). */
  drafting: string[];
  events?: CheckEvent[];
  qaUrl?: string;
  /** Open tasks of this chat, newest first ("Waiting on #a1b2, #c3d4, and 3 other tasks"). */
  waiting?: WaitingTask[];
  onOpenTask?: (taskId: string) => void;
}) {
  const busy = agents
    .map((a) => ({ agent: a, entry: status?.[a._id] }))
    .filter((x): x is { agent: Agent; entry: TeamStatusEntry & { status: keyof typeof ORDER } } =>
      Boolean(x.entry && x.entry.status in ORDER),
    )
    .sort((a, b) => ORDER[a.entry.status] - ORDER[b.entry.status]);

  let text: React.ReactNode = null;
  const primary = busy[0];
  if (primary) {
    const who = roleLabel(primary.agent.role);
    const { entry } = primary;
    if (entry.status === "testing") {
      const check = (events ?? []).find((e) => e.type === "task.check" && e.taskId === entry.taskId && e.payload?.label);
      const label = check?.payload?.label?.replace(/^verify:/, "");
      const url = hostPath(qaUrl);
      text = (
        <>
          {who} is checking{" "}
          {url ? <span className="font-mono text-[12.5px] text-ink-2">{url}</span> : (entry.taskTitle ?? "the change")}
          {label ? (/\d+\s?px/i.test(label) ? ` at ${label}` : ` · ${label}`) : ""}
        </>
      );
    } else {
      text = `${who} is ${entry.status === "reviewing" ? "reviewing" : "working on"} ${entry.taskTitle ?? "a task"}`;
    }
    const note = sandboxNote(events, entry.taskId);
    if (note) text = <>{text} <span className="text-ink-3">· {note}</span></>;
    if (busy.length > 1) text = <>{text} · {busy.length - 1} more busy</>;
  } else if (drafting.length > 0) {
    const [a, b] = drafting;
    text = drafting.length === 1 ? `${a} is drafting a reply` : drafting.length === 2 ? `${a} and ${b} are drafting replies` : `${a} and ${drafting.length - 1} others are drafting replies`;
  } else if (waiting.length > 0) {
    const named = waiting.slice(0, WAITING_NAMED);
    const rest = waiting.length - named.length;
    text = (
      <>
        Waiting on{" "}
        {named.map((task, i) => (
          <span key={task.id}>
            {i > 0 && (rest > 0 || named.length > 2 ? ", " : " and ")}
            <button type="button" onClick={() => onOpenTask?.(task.id)} className="text-ink-2 underline-offset-2 outline-none hover:text-ink hover:underline focus-visible:underline">
              {task.ref}
            </button>
          </span>
        ))}
        {rest > 0 && `, and ${rest} other task${rest === 1 ? "" : "s"}`}
      </>
    );
  }

  return (
    <div className="h-7 w-full shrink-0 px-4 sm:px-9 lg:px-11" aria-live="polite">
      {text && (
        <p role="status" className="h-7 truncate text-center text-[13px] leading-7 text-ink-3">
          {text}
        </p>
      )}
    </div>
  );
}
