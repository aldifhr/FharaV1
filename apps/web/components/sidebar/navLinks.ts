import { Activity, BookOpen, Brain, GitBranch, GitPullRequest, ScrollText, Sparkles } from "lucide-react";
import type { NavIcon } from "./SidebarNav";

export type NavLink = { icon: NavIcon; label: string; href?: string; onClick?: () => void; active: boolean };

/**
 * Build and observe destinations used by the sidebar and command menu, plus
 * development destinations kept in the command menu and shown on the icon rail.
 * LLM & Models is not here: it lives in Settings (tab "models").
 */
export function sidebarNavLinks({
  pathname,
  projectId,
}: {
  pathname: string;
  projectId?: string;
}) {
  const withProject = (href: string, param = "project") => (projectId ? `${href}${href.includes("?") ? "&" : "?"}${param}=${projectId}` : href);
  const build: NavLink[] = [
    { icon: BookOpen, label: "Library", href: withProject("/library"), active: pathname === "/library" },
    { icon: Brain, label: "Memory", href: projectId ? `/memory?scope=project&project=${projectId}` : "/memory", active: pathname === "/memory" },
  ];
  const development: NavLink[] = [
    { icon: GitPullRequest, label: "Pull requests", href: "/pull-requests", active: pathname.startsWith("/pull-requests") },
    { icon: GitBranch, label: "Runs", href: withProject("/runs"), active: pathname.startsWith("/runs") },
  ];
  const observe: NavLink[] = [
    { icon: Activity, label: "Activity", href: withProject("/activity"), active: pathname === "/activity" },
    { icon: ScrollText, label: "Audit log", href: withProject("/audit"), active: pathname === "/audit" },
    { icon: Sparkles, label: "Improve", href: withProject("/improve"), active: pathname === "/improve" },
  ];
  return { build, development, observe };
}
