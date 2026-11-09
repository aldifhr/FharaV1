"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { ArrowUp, FileDiff, GitMerge, HelpCircle, ShieldCheck, Terminal, type LucideIcon } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { roleLabel } from "@/lib/agentRoles";
import { useOptionalWorkspace } from "@/app/WorkspaceContext";
import { SectionToggle } from "./SectionToggle";
import { clockTime, isSameDay, shortDate } from "@/lib/format";

const KIND_ICON: Record<string, { icon: LucideIcon; tone: string }> = {
  push: { icon: ArrowUp, tone: "bg-warn-soft text-warn" },
  changes: { icon: FileDiff, tone: "bg-warn-soft text-warn" },
  command: { icon: Terminal, tone: "bg-warn-soft text-warn" },
  merge: { icon: GitMerge, tone: "bg-warn-soft text-warn" },
  question: { icon: HelpCircle, tone: "bg-brand-soft text-brand-ink" },
  review: { icon: ShieldCheck, tone: "bg-warn-soft text-warn" },
};

const MAX_SHOWN = 3;

function timeOf(ms: number): string {
  return isSameDay(ms) ? clockTime(ms) : shortDate(ms);
}

/** "Needs you": everything waiting on the user across projects. */
export default function NeedsYou({
  open,
  onToggle,
  onNavigate,
}: {
  open: boolean;
  onToggle: () => void;
  /** Called after an item was opened (closes the phone drawer). */
  onNavigate?: () => void;
}) {
  const data = useQuery(api.shell.needsYou, {});
  const workspace = useOptionalWorkspace();
  const router = useRouter();
  const items = data?.items ?? [];

  const openItem = (item: (typeof items)[number]) => {
    onNavigate?.();
    if (workspace && workspace.projectId === item.projectId && item.taskId) {
      workspace.selectTask(item.taskId);
      return;
    }
    router.push(`/chats/${item.projectId}${item.taskId ? `?task=${item.taskId}` : ""}`);
  };

  return (
    <section aria-label="Needs you">
      <SectionToggle title="Needs you" count={data?.total} open={open} onToggle={onToggle} />
      {open && data === undefined && <div className="mx-1 mt-2 h-[68px] animate-pulse rounded-xl bg-hover" />}
      {open && data && items.length === 0 && <p className="px-2 pt-1.5 text-[13px] text-ink-3">You&apos;re all caught up.</p>}
      {open && items.length > 0 && (
        <ul className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
          {items.slice(0, MAX_SHOWN).map((item) => {
            const meta = KIND_ICON[item.kind] ?? KIND_ICON.review;
            const Icon = meta.icon;
            const who = item.agentRole ? roleLabel(item.agentRole) : item.projectName;
            return (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => openItem(item)}
                  className="flex w-full items-start gap-3 px-3 py-2.5 text-left outline-none transition hover:bg-hover focus-visible:bg-hover"
                >
                  <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${meta.tone}`}>
                    <Icon size={13} strokeWidth={2.25} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-[14px] font-medium leading-snug text-ink">{item.title}</span>
                    <span className="mt-0.5 block truncate text-[13px] text-ink-3">
                      {who} · {item.note ?? timeOf(item.at)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {open && items.length > MAX_SHOWN && (
        <Link href="/inbox" onClick={onNavigate} className="mt-1.5 block px-2 text-[13px] text-brand-ink hover:underline">
          View all {data?.total} in Inbox
        </Link>
      )}
    </section>
  );
}
