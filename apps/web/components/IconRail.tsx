"use client";
import { Home, Inbox, Search, MessageSquare, SquareKanban, Users, Activity, HeartPulse, Blocks, Brain, Plus, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
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
  const pathname = usePathname();
  const inbox = useQuery(api.inbox.list, {});
  const inboxCount = inbox ? inbox.approvals.length + inbox.tasks.length + inbox.agents.length : 0;
  const RailBtn = ({ icon: Icon, label, href, badge, active, onClick, count }: any) => {
    const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);
    const anchorRef = useRef<HTMLAnchorElement | null>(null);

    const showTooltip = (event: MouseEvent<HTMLAnchorElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setTooltip({ x: rect.right + 10, y: rect.top + rect.height / 2 });
    };
    const hideTooltip = () => setTooltip(null);

    return (
      <motion.div whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.94 }}>
      <Link
        ref={anchorRef}
        href={href}
        onClick={onClick}
        title={label}
        aria-label={label}
        onMouseEnter={showTooltip}
        onMouseMove={showTooltip}
        onMouseLeave={hideTooltip}
        className={`group relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white/65 transition hover:bg-white/15 hover:text-white ${active ? "bg-white/20 text-white shadow-sm" : ""}`}
      >
        <Icon size={20} />
        {count > 0 && (
          <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
            {count > 9 ? "9+" : count}
          </span>
        )}
        {badge && count === 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-rose-500" />}
      </Link>
      {tooltip && typeof document !== "undefined" && createPortal(
        <span
          className="pointer-events-none fixed z-[70] -translate-y-1/2 whitespace-nowrap rounded-lg bg-gray-900 px-2 py-1 text-xs text-white shadow-lg"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {label}
        </span>,
        document.body,
      )}
      </motion.div>
    );
  };

  return (
    <nav className="flex h-full w-[58px] shrink-0 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto border-r border-white/10 bg-gradient-to-b from-[#6d5cf0] via-[#5b4bd6] to-[#4534a6] py-3 shadow-[inset_-1px_0_rgba(255,255,255,.12)] dark:border-white/5 dark:from-[#241e4a] dark:via-[#191534] dark:to-[#0e0b20] max-[979px]:h-14 max-[979px]:w-full max-[979px]:flex-row max-[979px]:justify-between max-[979px]:overflow-x-auto max-[979px]:overflow-y-hidden max-[979px]:border-r-0 max-[979px]:border-b max-[979px]:bg-gradient-to-r max-[979px]:px-3">
      <div className="flex shrink-0 flex-col items-center gap-2">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/20 text-lg font-bold text-white">A</div>
        {onNewProject ? (
          <button onClick={onNewProject} title="New project" aria-label="New project" className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/25 text-white hover:bg-white/15">
            <Plus size={18} />
          </button>
        ) : (
          <Link href="/?new=project" title="New project" aria-label="New project" className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/25 text-white hover:bg-white/15">
            <Plus size={18} />
          </Link>
        )}
      </div>
      <div className="mt-5 flex shrink-0 flex-col gap-1 max-[979px]:mt-0 max-[979px]:flex-row">
        {MENU.map((m) => <RailBtn key={m.label} {...m} count={m.label === "Inbox" ? inboxCount : 0} />)}
      </div>
      <div className="mt-5 flex shrink-0 flex-col gap-1 max-[979px]:mt-0 max-[979px]:flex-row">
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
      <div className="mt-auto flex shrink-0 flex-col items-center gap-1 pt-2 max-[979px]:mt-0 max-[979px]:flex-row max-[979px]:pt-0">
        <RailBtn icon={Settings} label="Settings" href="/settings" active={pathname === "/settings"} />
        <ThemeToggle />
      </div>
    </nav>
  );
}
