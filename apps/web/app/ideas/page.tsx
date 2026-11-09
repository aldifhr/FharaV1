"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { Lightbulb, Plus, Trash2 } from "lucide-react";
import IconRail from "@/components/IconRail";
import { BlurFade } from "@/components/ui/blur-fade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { shortDate } from "@/lib/format";

type Idea = {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
};

type IdeaFilter = "all" | "active" | "done";

const IDEAS_STORAGE_KEY = "moagent.ideas";

const FILTERS: { key: IdeaFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "done", label: "Done" },
];

function loadIdeas(): Idea[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(IDEAS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is Idea =>
        !!entry &&
        typeof (entry as Idea).id === "string" &&
        typeof (entry as Idea).text === "string"
    );
  } catch {
    return [];
  }
}

function newIdeaId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `idea-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function IdeasPage() {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState<IdeaFilter>("all");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setIdeas(loadIdeas());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(IDEAS_STORAGE_KEY, JSON.stringify(ideas));
    } catch {
      // Storage unavailable - keep the in-memory list only.
    }
  }, [ideas, hydrated]);

  const addIdea = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setIdeas((prev) => [{ id: newIdeaId(), text, done: false, createdAt: Date.now() }, ...prev]);
    setDraft("");
  };

  const toggleIdea = (id: string) => {
    setIdeas((prev) => prev.map((i) => (i.id === id ? { ...i, done: !i.done } : i)));
  };

  const removeIdea = (id: string) => {
    setIdeas((prev) => prev.filter((i) => i.id !== id));
  };

  const clearDone = () => {
    setIdeas((prev) => prev.filter((i) => !i.done));
  };

  const visibleIdeas = useMemo(() => {
    if (filter === "all") return ideas;
    return ideas.filter((i) => (filter === "done" ? i.done : !i.done));
  }, [ideas, filter]);

  const doneCount = ideas.filter((i) => i.done).length;
  const totalCount = ideas.length;
  const progressPct = totalCount === 0 ? 0 : Math.round((doneCount / totalCount) * 100);

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-gray-900 dark:text-gray-100 max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail />
      <main className="min-w-0 flex-1 overflow-y-auto p-6 max-[979px]:p-4">
        <div className="mx-auto max-w-2xl">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#eeecfb] text-[#5147b4] dark:bg-gray-800 dark:text-indigo-300">
              <Lightbulb size={20} />
            </span>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">Ideas</h1>
              <p className="mt-1 text-sm text-gray-500">
                Next MOAgent ideas, parked here as a todo list.
              </p>
            </div>
          </motion.div>

          <Card className="mt-6 border-[#ebe9f0] shadow-[0_1px_2px_rgba(30,25,60,.03)] dark:border-gray-800 dark:bg-gray-900">
            <CardContent className="p-4">
              <form onSubmit={addIdea} className="flex items-center gap-2">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="What should MOAgent try next?"
                  aria-label="New idea"
                />
                <Button
                  type="submit"
                  disabled={!draft.trim()}
                  className="shrink-0 rounded-lg bg-[#6252d8] px-4 py-2 text-sm font-medium text-white hover:bg-[#5147b4] disabled:opacity-50"
                >
                  <Plus /> Add idea
                </Button>
              </form>
            </CardContent>
          </Card>

          {totalCount > 0 && (
            <div className="mt-6 flex items-center gap-3">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                <div className="h-full rounded-full bg-[#5147b4]" style={{ width: `${progressPct}%` }} />
              </div>
              <span className="shrink-0 text-xs font-medium text-gray-500 dark:text-gray-400">
                {doneCount} of {totalCount} done
              </span>
              {doneCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearDone}
                  className="shrink-0 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
                >
                  Clear completed
                </Button>
              )}
            </div>
          )}

          <div className="mt-6 flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1 dark:border-gray-700 dark:bg-gray-800">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition",
                  filter === f.key
                    ? "bg-white text-[#4c42a3] shadow-sm dark:bg-gray-900 dark:text-indigo-300"
                    : "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="mt-4 grid gap-2">
            {visibleIdeas.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-400 dark:border-gray-700">
                {filter === "done"
                  ? "No completed ideas yet."
                  : filter === "active"
                    ? "No active ideas. Add the next one below."
                    : "No ideas yet. Add your first MOAgent idea below."}
              </div>
            ) : (
              visibleIdeas.map((idea, i) => (
                <BlurFade key={idea.id} delay={i * 0.04} inView>
                  <div className="flex items-start gap-3 rounded-xl border border-[#ebe9f0] bg-white p-4 shadow-[0_1px_2px_rgba(30,25,60,.03)] dark:border-gray-800 dark:bg-gray-900">
                    <input
                      type="checkbox"
                      checked={idea.done}
                      onChange={() => toggleIdea(idea.id)}
                      aria-label={idea.done ? `Mark "${idea.text}" as not done` : `Mark "${idea.text}" as done`}
                      className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[#5147b4]"
                    />
                    <div className="min-w-0 flex-1">
                      <p className={cn("text-sm font-medium leading-snug", idea.done && "text-gray-400 line-through")}>
                        {idea.text}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500">
                        Added {shortDate(idea.createdAt)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeIdea(idea.id)}
                      aria-label="Delete idea"
                      className="shrink-0 text-gray-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </BlurFade>
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
