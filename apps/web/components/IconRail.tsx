"use client";
import Link from "next/link";
import { Home, Inbox, Lightbulb, MessageSquare, Plus, Settings, Cpu, Search, Share2 } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
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
  { icon: Inbox, label: "Inbox", href: "/inbox" },
  { icon: MessageSquare, label: "Chat", href: "/chats" },
  { icon: Lightbulb, label: "Ideas", href: "/ideas" },
];

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
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [userMenuPos, setUserMenuPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const avatarBtnRef = useRef<HTMLButtonElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const RailBtn = ({ icon: Icon, label, href, active, onClick, count }: any) => {
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
      "aria-current": active ? ("page" as const) : undefined,
      className: `group relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[#5147b4] outline-none transition focus-visible:ring-2 focus-visible:ring-[#635bff]/50 hover:bg-[#eceaf3] hover:text-[#3d34a0] dark:text-white/65 dark:hover:bg-white/15 dark:hover:text-white ${active ? "bg-[#5147b4] text-white shadow-sm hover:bg-[#5147b4] dark:bg-white/20 dark:hover:bg-white/15" : ""}`,
    };

    const inner = (
      <>
        <Icon size={20} />
        {count > 0 && (
          <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
            {count > 9 ? "9+" : count}
          </span>
        )}
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

  useEffect(() => {
    if (!userMenuOpen) return;
    const handlePointerDown = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (avatarBtnRef.current?.contains(target) || userMenuRef.current?.contains(target)) return;
      setUserMenuOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setUserMenuOpen(false);
    };
    const handleResize = () => setUserMenuOpen(false);
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
    };
  }, [userMenuOpen]);

  const toggleUserMenu = () => {
    if (userMenuOpen) {
      setUserMenuOpen(false);
      return;
    }
    const rect = avatarBtnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuWidth = 220;
    const isTopBar = rect.top < 80;
    const left = Math.min(
      Math.max(8, isTopBar ? rect.right - menuWidth : rect.right + 10),
      Math.max(8, window.innerWidth - menuWidth - 8)
    );
    setUserMenuPos(
      isTopBar
        ? { left, top: rect.bottom + 8 }
        : { left, bottom: window.innerHeight - rect.top + 8 }
    );
    setUserMenuOpen(true);
  };

  const isMenuActive = (href: string) => {
    if (href === "/") return pathname === "/";
    // Highlight Chat inside a project too (/chats/<id>).
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <nav className="flex h-full w-[64px] shrink-0 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto border-r border-[#e7e5ef] bg-white py-3 pt-9 shadow-[inset_-1px_0_rgba(30,25,60,.04)] dark:border-white/5 dark:bg-[#0e0b20] max-[979px]:h-14 max-[979px]:w-full max-[979px]:flex-row max-[979px]:justify-between max-[979px]:overflow-x-auto max-[979px]:overflow-y-hidden max-[979px]:border-r-0 max-[979px]:border-b max-[979px]:px-3 max-[979px]:pt-3">
      <CommandMenu open={commandOpen} onClose={() => setCommandOpen(false)} />
      <div className="flex shrink-0 flex-col items-center gap-2">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#635bff] text-white shadow-sm">
          <Share2 size={18} />
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
            active={isMenuActive(m.href)}
            count={m.label === "Inbox" ? inboxCount : 0}
          />
        ))}
      </div>
      <div className="mt-auto flex shrink-0 flex-col items-center gap-1 pt-2 max-[979px]:mt-0 max-[979px]:flex-row max-[979px]:pt-0">
        <button
          ref={avatarBtnRef}
          type="button"
          onClick={toggleUserMenu}
          aria-haspopup="menu"
          aria-expanded={userMenuOpen}
          aria-label="User account"
          title="User account"
          className="mt-2 flex h-8 w-8 items-center justify-center rounded-full bg-[#1e1b2e] text-[11px] font-bold text-white shadow-xs ring-2 ring-white transition hover:opacity-90 dark:ring-gray-900"
        >
          AF
        </button>
      </div>
      {userMenuOpen && userMenuPos && typeof document !== "undefined" && createPortal(
        <motion.div
          ref={userMenuRef}
          role="menu"
          aria-label="User account"
          initial={{ opacity: 0, y: 4, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.14, ease: "easeOut" }}
          className="fixed z-[70] w-[220px] rounded-xl border border-[#ebe9f0] bg-white p-1.5 shadow-xl dark:border-gray-800 dark:bg-gray-900"
          style={{ left: userMenuPos.left, top: userMenuPos.top, bottom: userMenuPos.bottom }}
        >
          <div className="flex items-center gap-2.5 px-2 py-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1e1b2e] text-[11px] font-bold text-white">
              AF
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">Local user</span>
              <span className="block truncate text-xs text-gray-500">Single-user workspace</span>
            </span>
          </div>
          <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setUserMenuOpen(false);
              openSettings();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-gray-100 dark:hover:bg-white/10"
          >
            <Settings size={16} className="shrink-0 text-gray-500" />
            Settings
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setUserMenuOpen(false);
              openLlmSettings(projectId);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-gray-100 dark:hover:bg-white/10"
          >
            <Cpu size={16} className="shrink-0 text-gray-500" />
            LLM Settings
          </button>
          <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
          <p className="px-2 py-1 text-[11px] leading-snug text-gray-400">
            No sign-out — this device runs locally in single-user mode.
          </p>
        </motion.div>,
        document.body,
      )}
    </nav>
  );
}
