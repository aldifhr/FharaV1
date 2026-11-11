import { BookOpen, Brain, Cpu, GitBranch, Plug, ScrollText, Sparkles, TestTubes } from "lucide-react";
import type { NavIcon } from "./SidebarNav";

export type NavLink = { icon: NavIcon; label: string; href?: string; onClick?: () => void; active: boolean };

/**
 * The BUILD and OBSERVE rows of the sidebar, shared with the command menu so
 * both always list the same destinations (dashboard restyle F2/F6).
 */
export function sidebarNavLinks({
  pathname,
  projectId,
  openSettings,
}: {
  pathname: string;
  projectId?: string;
  openSettings: (projectId?: string, section?: string) => void;
}) {
  const withProject = (href: string, param = "project") => (projectId ? `${href}${href.includes("?") ? "&" : "?"}${param}=${projectId}` : href);
  const build: NavLink[] = [
    { icon: BookOpen, label: "Library", href: withProject("/library"), active: pathname === "/library" },
    { icon: Brain, label: "Memory", href: projectId ? `/memory?scope=project&project=${projectId}` : "/memory", active: pathname === "/memory" },
    { icon: TestTubes, label: "Agent Sandbox", href: "/playground", active: pathname === "/playground" },
    { icon: Cpu, label: "LLM & Models", onClick: () => openSettings(projectId, "models"), active: false },
    { icon: Plug, label: "Integrations", href: withProject("/integrations"), active: pathname === "/integrations" },
  ];
  const observe: NavLink[] = [
    { icon: GitBranch, label: "Runs", href: withProject("/runs"), active: pathname.startsWith("/runs") },
    { icon: ScrollText, label: "Audit log", href: withProject("/audit"), active: pathname === "/audit" },
    { icon: Sparkles, label: "Improve", href: withProject("/improve"), active: pathname === "/improve" },
  ];
  return { build, observe, teamHref: withProject("/team") };
}
