import { BookOpen, Brain, FlaskConical, GitBranch, ScrollText, Sparkles } from "lucide-react";
import type { NavIcon } from "./SidebarNav";

export type NavLink = { icon: NavIcon; label: string; href?: string; onClick?: () => void; active: boolean };

/**
 * The BUILD, DEVELOPMENT and OBSERVE rows of the sidebar, shared with the
 * command menu so both always list the same destinations (dashboard restyle
 * F2/F6). Development holds Runs. LLM & Models and Integrations are not here: they live in Settings
 * (tabs "models" and "integrations").
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
    { icon: FlaskConical, label: "Sandbox", href: withProject("/sandbox"), active: pathname === "/sandbox" },
  ];
  const development: NavLink[] = [
    { icon: GitBranch, label: "Runs", href: withProject("/runs"), active: pathname.startsWith("/runs") },
  ];
  const observe: NavLink[] = [
    { icon: ScrollText, label: "Audit log", href: withProject("/audit"), active: pathname === "/audit" },
    { icon: Sparkles, label: "Improve", href: withProject("/improve"), active: pathname === "/improve" },
  ];
  return { build, development, observe, teamHref: withProject("/team") };
}
