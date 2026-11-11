"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import {
  FolderKanban,
  FolderPlus,
  Inbox,
  ListPlus,
  MessageCircle,
  MessageSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings as SettingsIcon,
  Sun,
  Users,
} from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import AgentAvatar from "./AgentAvatar";
import { agentName, roleLabel } from "@/lib/agentRoles";
import { newTaskHref, recentThreads } from "@/lib/commandMenu";
import { useUiPref } from "@/lib/uiPrefs";
import { DESKTOP_QUERY, useMediaQuery } from "@/lib/useMediaQuery";
import { useNewProject } from "./NewProject";
import { NAV_ITEMS as SETTINGS_TABS, useSettings } from "./Settings";
import { useTheme } from "./ui/use-theme";
import { sidebarNavLinks, type NavLink } from "./sidebar/navLinks";
import type { NavIcon } from "./sidebar/SidebarNav";
import { useAllThreads } from "./sidebar/useAllThreads";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

const itemClass = "my-0.5 min-w-0 gap-2.5 rounded-field px-3 py-2";
const textClass = "flex min-w-0 flex-1 flex-col gap-0.5";
const titleClass = "block truncate text-sm font-medium leading-snug";
const subClass = "block truncate text-xs leading-normal text-muted-foreground";

type Entry = { key: string; label: string; sub?: string; icon?: NavIcon; keywords?: string; run: () => void };

function EntryGroup({ heading, entries }: { heading: string; entries: Entry[] }) {
  if (!entries.length) return null;
  return (
    <CommandGroup heading={heading}>
      {entries.map((e) => {
        const Icon = e.icon;
        return (
          <CommandItem key={e.key} value={`${heading} ${e.label} ${e.sub ?? ""} ${e.keywords ?? ""} ${e.key}`} className={itemClass} onSelect={e.run}>
            {Icon ? <Icon size={16} strokeWidth={1.6} className="shrink-0 text-ink-3" /> : null}
            <span className={textClass}>
              <span className={titleClass}>{e.label}</span>
              {e.sub ? <span className={subClass}>{e.sub}</span> : null}
            </span>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

/**
 * ⌘K (dashboard restyle F6): actions, the sidebar's destinations by group,
 * recent threads, settings tabs while typing, and the global search
 * (`api.search.global`) for projects, tasks and agents.
 */
export default function CommandMenu({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);
  const typed = q.trim();
  const results = useQuery(api.search.global, typed ? { q } : "skip");
  const threads = useAllThreads(open);
  const recent = useMemo(() => recentThreads(threads), [threads]);
  const { openNewProject } = useNewProject();
  const { openSettings } = useSettings();
  const { theme, toggleTheme } = useTheme();
  const isDesktop = useMediaQuery(DESKTOP_QUERY, true);
  const [collapsed, setCollapsed] = useUiPref("sidebarCollapsed");

  const go = (href: string) => () => {
    onClose();
    router.push(href);
  };
  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };

  // "New task" lands in the open project, else the most recently active one.
  const taskProject = projectId
    ? { id: projectId, name: null as string | null }
    : threads?.length
      ? (() => {
          const newest = [...threads].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
          return { id: newest.projectId, name: newest.projectName };
        })()
      : null;

  const actions: Entry[] = [
    { key: "new-project", label: "New project", icon: FolderPlus, keywords: "create add", run: act(openNewProject) },
    ...(taskProject
      ? [{ key: "new-task", label: "New task", sub: taskProject.name ? `In ${taskProject.name}` : undefined, icon: ListPlus, keywords: "create add", run: go(newTaskHref(taskProject.id)) }]
      : []),
    { key: "settings", label: "Open settings", icon: SettingsIcon, keywords: "preferences", run: act(() => openSettings(projectId)) },
    {
      key: "theme",
      label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      icon: theme === "dark" ? Sun : Moon,
      keywords: "toggle theme appearance dark light mode",
      run: act(toggleTheme),
    },
    ...(isDesktop
      ? [{
          key: "sidebar",
          label: collapsed ? "Expand sidebar" : "Collapse sidebar",
          icon: collapsed ? PanelLeftOpen : PanelLeftClose,
          keywords: "toggle sidebar rail",
          run: act(() => setCollapsed(!collapsed)),
        }]
      : []),
  ];

  const { build, observe, teamHref } = sidebarNavLinks({ pathname: pathname ?? "", projectId, openSettings });
  const fromLinks = (links: NavLink[]): Entry[] =>
    links.map((l) => ({ key: l.label, label: l.label, icon: l.icon, run: l.href ? go(l.href) : act(() => l.onClick?.()) }));
  const work: Entry[] = [
    { key: "projects", label: "Projects", icon: FolderKanban, run: go("/chats") },
    { key: "personal", label: "Personal messages", icon: MessageCircle, keywords: "direct", run: go("/chats/personal") },
    { key: "team", label: "Team", icon: Users, keywords: "agents", run: go(teamHref) },
  ];
  const observeEntries: Entry[] = [
    { key: "inbox", label: "Inbox", icon: Inbox, keywords: "needs you approvals", run: go("/inbox") },
    ...fromLinks(observe),
  ];
  const recentEntries: Entry[] = recent.map((t) => ({
    key: t.id,
    label: t.title,
    sub: t.needsYou ? `${t.projectName} · Needs you` : t.projectName,
    icon: MessageSquare,
    run: go(t.href),
  }));
  // Every settings tab, only while typing so the empty menu stays short.
  const settingsEntries: Entry[] = typed
    ? SETTINGS_TABS.map((tab) => ({ key: tab.id, label: `Settings: ${tab.label}`, icon: tab.icon, keywords: tab.group, run: act(() => openSettings(projectId, tab.id)) }))
    : [];

  const searchGroups: ReactNode = (
    <>
      {results?.projects.length ? (
        <CommandGroup heading="Projects">
          {results.projects.map((p) => (
            <CommandItem key={p._id} value={`${p.name} ${p.workspacePath}`} className={itemClass} onSelect={go(`/chats/${p._id}`)}>
              <span className={textClass}>
                <span className={titleClass}>{p.name}</span>
                <span className={subClass}>{p.workspacePath}</span>
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
      {results?.tasks.length ? (
        <CommandGroup heading="Tasks">
          {results.tasks.map((t) => (
            <CommandItem key={t._id} value={`${t.title} ${t.projectName} ${t.status}`} className={itemClass} onSelect={go(`/chats/${t.projectId}`)}>
              <span className={textClass}>
                <span className={titleClass}>{t.title}</span>
                <span className={subClass}>{t.projectName} · {t.status}</span>
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
      {results?.agents.length ? (
        <CommandGroup heading="Agents">
          {results.agents.map((a) => (
            <CommandItem
              key={a._id}
              value={`${agentName(a)} ${roleLabel(a.role)} ${a.status}`}
              className={itemClass}
              onSelect={() => { onClose(); if (a.projectId) router.push(`/chats/${a.projectId}`); }}
            >
              <AgentAvatar name={agentName(a)} size={20} status={a.status} avatarParams={a.avatarParams} />
              <span className={textClass}>
                <span className={titleClass}>{agentName(a)}</span>
                <span className={subClass}>{a.status}</span>
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
    </>
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={onClose}
      title="Command menu"
      description="Run an action, go to a page, or search projects, tasks, and agents"
      className="w-[min(560px,calc(100vw-32px))] max-w-full p-2 sm:max-w-[560px]"
    >
      <CommandPrimitive
        className="w-full min-w-0 overflow-hidden"
        filter={(value, search) => {
          const needle = search.toLowerCase();
          if (!needle) return 1;
          return value.toLowerCase().includes(needle) ? 1 : 0;
        }}
      >
        <CommandInput value={q} onValueChange={setQ} placeholder="Type a command or search…" />
        <CommandList className="max-h-[min(60vh,440px)] p-1">
          <CommandEmpty>No results.</CommandEmpty>
          {typed ? searchGroups : null}
          <EntryGroup heading="Actions" entries={actions} />
          <EntryGroup heading="Recent threads" entries={recentEntries} />
          <EntryGroup heading="Work" entries={work} />
          <EntryGroup heading="Build" entries={fromLinks(build)} />
          <EntryGroup heading="Observe" entries={observeEntries} />
          <EntryGroup heading="Settings" entries={settingsEntries} />
        </CommandList>
      </CommandPrimitive>
    </CommandDialog>
  );
}
