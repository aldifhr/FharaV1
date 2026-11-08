/**
 * Display label for an agent role. The team UI shows roles only, never
 * individual agent names, so every agent-facing label goes through here.
 */
export const ROLE_LABELS: Record<string, string> = {
  lead: "Lead",
  cto: "CTO",
  designer: "Designer",
  frontend: "Frontend",
  backend: "Backend",
  qa: "QA",
  growth: "Growth",
  support: "Support",
  reviewer: "Reviewer",
  researcher: "Researcher",
  "product-analyst": "Product Analyst",
  "ui-ux": "Designer",
  devops: "DevOps",
};

export const FIXED_ROLE_KEYS = [
  "lead",
  "cto",
  "designer",
  "frontend",
  "backend",
  "qa",
  "growth",
  "support",
] as const;

export type FixedRoleKey = (typeof FIXED_ROLE_KEYS)[number];

export const ROLE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  lead: { bg: "bg-purple-500/10 dark:bg-purple-500/20", text: "text-purple-600 dark:text-purple-400", border: "border-purple-500/20" },
  cto: { bg: "bg-blue-500/10 dark:bg-blue-500/20", text: "text-blue-600 dark:text-blue-400", border: "border-blue-500/20" },
  designer: { bg: "bg-pink-500/10 dark:bg-pink-500/20", text: "text-pink-600 dark:text-pink-400", border: "border-pink-500/20" },
  frontend: { bg: "bg-emerald-500/10 dark:bg-emerald-500/20", text: "text-emerald-600 dark:text-emerald-400", border: "border-emerald-500/20" },
  backend: { bg: "bg-amber-500/10 dark:bg-amber-500/20", text: "text-amber-600 dark:text-amber-400", border: "border-amber-500/20" },
  qa: { bg: "bg-orange-500/10 dark:bg-orange-500/20", text: "text-orange-600 dark:text-orange-400", border: "border-orange-500/20" },
  growth: { bg: "bg-teal-500/10 dark:bg-teal-500/20", text: "text-teal-600 dark:text-teal-400", border: "border-teal-500/20" },
  support: { bg: "bg-indigo-500/10 dark:bg-indigo-500/20", text: "text-indigo-600 dark:text-indigo-400", border: "border-indigo-500/20" },
};

/** Role label for a role key, e.g. "frontend" -> "Frontend". */
export function roleLabel(role: string | null | undefined): string {
  const key = (role ?? "").trim().toLowerCase();
  if (!key) return "Agent";
  return (
    ROLE_LABELS[key] ??
    key
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}
