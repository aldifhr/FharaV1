"use client";
import { Home, Inbox, Search, MessageSquare, SquareKanban, Users, Activity, HeartPulse, Blocks, Brain, Plus } from "lucide-react";
import Link from "next/link";
import type { MouseEvent } from "react";
import { useQuery } from "convex/react";
import { motion } from "framer-motion";
import { ThemeToggle } from "./ui/theme-toggle";
import { api } from "../../api/convex/_generated/api";

const MENU = [
  { icon: Home, label: "Home", href: "/" },
  { icon: Inbox, label: "Inbox", href: "/inbox", badge: true },
  { icon: Search, label: "Search", href: "/search" },
];
export type WorkspaceSection = "chat" | "board" | "team" | "activity" | "health" | "integrations" | "memory";

const WS: { icon: typeof MessageSquare; label: string; key: WorkspaceSection; badge?: boolean }[] = [
  { icon: MessageSquare, label: "Chat", key: "chat" },
  { icon: SquareKanban, label: "Board", key: "board" },
  { icon: Users, label: "Team", key: "team" },
  { icon: Activity, label: "Activity", key: "activity" },
  { icon: HeartPulse, label: "Agent health", key: "health", badge: true },
  { icon: Blocks, label: "Integrations", key: "integrations" },
  { icon: Brain, label: "Memory", key: "memory" },
];

export default function IconRail({
  onNewProject,
  projectId,
  activeSection,
  onSectionChange,
}: {
  onNewProject?: () => void;
  projectId?: string;
  activeSection?: WorkspaceSection;
  onSectionChange?: (section: WorkspaceSection) => void;
}) {
  const workspaceHref = projectId ? `/workspace/${projectId}` : "/chat";
  const inbox = useQuery(api.inbox.list, {});
  const inboxCount = inbox ? inbox.approvals.length + inbox.tasks.length + inbox.agents.length : 0;
  const RailBtn = ({ icon: Icon, label, href, badge, active, onClick, count }: any) => (
    <motion.div whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.94 }}>
    <Link href={href} onClick={onClick} title={label} className={`group relative flex h-10 w-10 items-center justify-center rounded-xl text-white/65 transition hover:bg-white/15 hover:text-white ${active ? "bg-white/20 text-white shadow-sm" : ""}`}>
      <Icon size={20} />
      {count > 0 && (
        <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
          {count > 9 ? "9+" : count}
        </span>
      )}
      {badge && count === 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-rose-500" />}
      <span className="pointer-events-none absolute left-full ml-2 hidden whitespace-nowrap rounded-lg bg-gray-900 px-2 py-1 text-xs text-white shadow-lg group-hover:block">
        {label}
      </span>
    </Link>
    </motion.div>
  );

  return (
    <nav className="flex h-full w-[58px] shrink-0 flex-col items-center gap-1 bg-[#6252d8] py-3 shadow-[inset_-1px_0_rgba(255,255,255,.12)] max-[979px]:h-14 max-[979px]:w-full max-[979px]:flex-row max-[979px]:justify-between max-[979px]:px-3">
      <div className="flex flex-col items-center gap-2">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/20 text-lg font-bold text-white">A</div>
        <button onClick={onNewProject} title="New project" className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/25 text-white hover:bg-white/15">
          <Plus size={18} />
        </button>
      </div>
      <div className="mt-5 flex flex-col gap-1 max-[979px]:mt-0 max-[979px]:flex-row">
        {MENU.map((m) => <RailBtn key={m.label} {...m} count={m.label === "Inbox" ? inboxCount : 0} />)}
      </div>
      <div className="mt-5 flex flex-col gap-1 max-[979px]:mt-0 max-[979px]:flex-row">
        {WS.map((m) => (
          <RailBtn
            key={m.label}
            icon={m.icon}
            label={m.label}
            href={projectId ? `${workspaceHref}?section=${m.key}` : workspaceHref}
            badge={m.badge}
            active={activeSection === m.key}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              if (onSectionChange) {
                event.preventDefault();
                onSectionChange(m.key);
              }
            }}
          />
        ))}
      </div>
      <div className="mt-auto flex flex-col max-[979px]:mt-0">
        <ThemeToggle />
      </div>
    </nav>
  );
}
