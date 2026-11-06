"use client";
import Link from "next/link";
import { Home, Inbox, Search, MessageSquare, Activity, BarChart3, Plus, Settings, Cpu } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import { useQuery } from "convex/react";
import { motion } from "framer-motion";
import { useNewProject } from "./NewProject";
import { useSettings } from "./Settings";
import { useLlmSettings } from "./LlmSettings";
import { api } from "@/api/convex/_generated/api";
import CommandMenu from "./CommandMenu";
const MENU = [
  { icon: Home, label: "Home", href: "/" },
  { icon: MessageSquare, label: "Chats", href: "/chats" },
  { icon: Inbox, label: "Inbox", href: "/inbox", badge: true },
  { icon: BarChart3, label: "Analytics", href: "/analytics" },
  { icon: Activity, label: "Activities", href: "/activities" },
];export type WorkspaceSection = never;

export default function IconRail({
  onNewProject,
  projectId,
}: {
  onNewProject?: () => void;
  projectId?: string;
}) {
  const { openNewProject } = useNewProject();
  const { openSettings } = useSettings();
  const { openLlmSettings } = useLlmSettings();
  const pathname = usePathname();
  const inbox = useQuery(api.inbox.list, {});
  const inboxCount = inbox ? inbox.approvals.length + inbox.tasks.length + inbox.agents.length : 0;
  const [commandOpen, setCommandOpen] = useState(false);
  const activeSection = undefined;
  const RailBtn = ({ icon: Icon, label, href, badge, active, onClick, count }: any) => {
    const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);

    const showTooltip = (event: MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setTooltip({ x: rect.right + 10, y: rect.top + rect.height / 2 });
    };
    const hideTooltip = () => setTooltip(null);

    const shared = {
      title: label,
      "aria-label": label,
      onMouseEnter: showTooltip,
      onMouseMove: showTooltip,
      onMouseLeave: hideTooltip,
      className: `group relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[#5147b4] transition hover:bg-[#eceaf3] hover:text-[#3d34a0] dark:text-white/65 dark:hover:bg-white/15 dark:hover:text-white ${active ? "bg-[#5147b4] text-white shadow-sm hover:bg-[#5147b4] dark:bg-white/20 dark:hover:bg-white/15" : ""}`,
    };

    const inner = (
      <>
        <Icon size={20} />
        {count > 0 && (
          <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
            {count > 9 ? "9+" : count}
          </span>
        )}
        {badge && count === 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-rose-500" />}
      </>
    );

    return (
      <motion.div whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.94 }}>
      {href ? (
        <Link href={href} onClick={onClick} {...shared}>
          {inner}
        </Link>
      ) : (
        <button type="button" onClick={onClick} {...shared}>
          {inner}
        </button>
      )}
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <nav className="flex h-full w-[58px] shrink-0 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto border-r border-[#e7e5ef] bg-white py-3 shadow-[inset_-1px_0_rgba(30,25,60,.04)] dark:border-white/5 dark:to-[#0e0b20] dark:from-[#1b1833] dark:via-[#141127] dark:bg-gradient-to-b max-[979px]:h-14 max-[979px]:w-full max-[979px]:flex-row max-[979px]:justify-between max-[979px]:overflow-x-auto max-[979px]:overflow-y-hidden max-[979px]:border-r-0 max-[979px]:border-b max-[979px]:px-3">
      <CommandMenu open={commandOpen} onClose={() => setCommandOpen(false)} />
      <div className="flex shrink-0 flex-col items-center gap-2">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#eceaf3] font-bold text-[#5147b4] dark:bg-white/20 dark:text-white">
          <span className="text-lg">Z.</span>
        </div>
        <button
          onClick={onNewProject ?? openNewProject}
          title="New project"
          aria-label="New project"
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#e7e5ef] bg-white text-[#5147b4] hover:bg-[#eceaf3] dark:border-white/25 dark:bg-transparent dark:text-white dark:hover:bg-white/15"
        >
          <Plus size={18} />
        </button>
        <button
          onClick={() => setCommandOpen(true)}
          title="Search"
          aria-label="Search"
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#e7e5ef] bg-white text-[#5147b4] hover:bg-[#eceaf3] dark:border-white/25 dark:bg-transparent dark:text-white dark:hover:bg-white/15"
        >
          <Search size={18} />
        </button>
      </div>
      <div className="mt-5 flex shrink-0 flex-col gap-1 max-[979px]:mt-0 max-[979px]:flex-row">
        {MENU.map((m) => (
          <RailBtn
            key={m.label}
            {...m}
            count={m.label === "Inbox" ? inboxCount : 0}
          />
        ))}
      </div>
      <div className="mt-auto flex shrink-0 flex-col items-center gap-1 pt-2 max-[979px]:mt-0 max-[979px]:flex-row max-[979px]:pt-0">
        <RailBtn icon={Cpu} label="LLM Settings" onClick={() => openLlmSettings(projectId)} />
        <RailBtn icon={Settings} label="Settings" onClick={openSettings} />
      </div>
    </nav>
  );
}
