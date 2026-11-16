/**
 * What "backend" means for routing and assignment: server-side work in any
 * language. Convex is one backend stack among many, never the definition.
 * Pure data (no Convex import) so every caller joins the same word list.
 */
const BACKEND_TERMS = [
  "backend",
  "back-end",
  "api",
  "endpoints?",
  "database",
  "databases",
  "db",
  "schema",
  "skema",
  "tabel",
  "tables?",
  "convex",
  "query",
  "queries",
  "mutation",
  "mutations",
  "server",
  "server-side",
  "migrasi",
  "migration",
  "webhook",
  "cron",
  "jobs?",
  "indexes",
  "index db",
  "python",
  "django",
  "fastapi",
  "flask",
  "golang",
  "java",
  "kotlin",
  "spring",
  "rust",
  "ruby",
  "rails",
  "php",
  "laravel",
  "dotnet",
  "node",
  "express",
  "nestjs",
  "graphql",
  "grpc",
  "postgres",
  "postgresql",
  "mysql",
  "sqlite",
  "mongodb",
  "redis",
  "prisma",
  "drizzle",
  "auth",
];

export const BACKEND_WORD_SOURCE = BACKEND_TERMS.join("|");

export function backendWordPattern(flags = "i"): RegExp {
  return new RegExp(`\\b(?:${BACKEND_WORD_SOURCE})\\b`, flags);
}
