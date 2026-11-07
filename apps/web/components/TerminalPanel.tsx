"use client";
import { useEffect, useRef, useState } from "react";
import { useToast } from "./Toasts";

type Line = { kind: "in" | "out" | "err"; text: string };

export default function TerminalPanel({ workspacePath }: { workspacePath: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = command.trim();
    if (!trimmed || running) return;
    setRunning(true);
    setLines((l) => [...l, { kind: "in", text: `$ ${trimmed}` }]);
    setCommand("");
    try {
      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspacePath, command: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Terminal failed");
      const out = [...(data.stdout ?? "").split("\n").filter(Boolean).map((t: string) => ({ kind: "out" as const, text: t }))];
      const err = [...(data.stderr ?? "").split("\n").filter(Boolean).map((t: string) => ({ kind: "err" as const, text: t }))];
      setLines((l) => [...l, ...out, ...err]);
    } catch (err: any) {
      toast("error", "Terminal error", err.message);
      setLines((l) => [...l, { kind: "err", text: err.message }]);
    } finally {
      setRunning(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 space-y-1 overflow-y-auto rounded-xl bg-gray-950 p-4 font-mono text-xs leading-5">
        {lines.length === 0 && (
          <p className="text-gray-500">$ ketik perintah shell, contoh: git status / npm run typecheck</p>
        )}
        {lines.map((line, i) => (
          <div key={i} className={line.kind === "err" ? "text-red-400" : line.kind === "in" ? "text-emerald-300" : "text-gray-200"}>
            {line.text}
          </div>
        ))}
      </div>
      <form onSubmit={run} className="mt-3 flex items-center gap-2">
        <span className="font-mono text-xs font-bold text-emerald-500">$</span>
        <input
          ref={inputRef}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={running ? "running…" : "type a command…"}
          disabled={running}
          autoFocus
          className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        />
        <button
          type="submit"
          disabled={running || !command.trim()}
          className="rounded-lg bg-gray-900 px-4 py-2 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-gray-900"
        >
          Run
        </button>
      </form>
    </div>
  );
}
