"use client";

import { roleLabel } from "@/lib/agentRoles";
import type { StatusMap, TeamStatusEntry } from "@/lib/teamStatus";
import type { AgentRef as Agent } from "@/lib/types";

type CheckEvent = { taskId?: string; type: string; payload?: { label?: string }; _creationTime: number };

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

/**
 * One quiet line above the composer: who is doing what right now
 * ("QA is checking shedi.app at 375 px", "CTO is drafting a reply").
 */
export default function StatusLine({
  agents,
  status,
  drafting,
  events,
  qaUrl,
}: {
  agents: Agent[];
  status?: StatusMap;
  /** Roles drafting a chat reply (no execution lease). */
  drafting: string[];
  events?: CheckEvent[];
  qaUrl?: string;
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
          {url ? <code className="rounded bg-hover px-1.5 py-0.5 font-mono text-[12.5px] text-ink-2">{url}</code> : (entry.taskTitle ?? "the change")}
          {label ? (/\d+\s?px/i.test(label) ? ` at ${label}` : ` · ${label}`) : ""}
        </>
      );
    } else {
      text = `${who} is ${entry.status === "reviewing" ? "reviewing" : "working on"} ${entry.taskTitle ?? "a task"}`;
    }
    if (busy.length > 1) text = <>{text} · {busy.length - 1} more busy</>;
  } else if (drafting.length > 0) {
    const [a, b] = drafting;
    text = drafting.length === 1 ? `${a} is drafting a reply` : drafting.length === 2 ? `${a} and ${b} are drafting replies` : `${a} and ${drafting.length - 1} others are drafting replies`;
  }

  return (
    <div className="h-7 w-full shrink-0 px-4 sm:px-9 lg:px-11" aria-live="polite">
      {text && (
        <p role="status" className="flex h-7 min-w-0 items-center gap-2 truncate text-[13.5px] text-ink-2">
          <span className="shell-dots flex shrink-0 items-center gap-[3px] text-ink-3" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="truncate">{text}</span>
        </p>
      )}
    </div>
  );
}
