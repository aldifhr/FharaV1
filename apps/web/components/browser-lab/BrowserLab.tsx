"use client";

/**
 * Browser Lab (frontend only): an interactive browser inside Fhara.
 * You load a URL, watch it live in the embedded viewport, trigger
 * captures (screenshot, DOM, console, network) from the headless
 * Chromium behind `/api/browser-lab`, queue Playwright actions, and
 * export a snippet. Everything is recorded as local actions; nothing
 * is sent to Convex.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Code2, Globe, Play, Square, Terminal, Network, History, Download, RefreshCw } from "lucide-react";
import { useToast } from "../Toasts";
import {
  VIEWPORTS,
  captureSummary,
  loadSessions,
  looksLikeUrl,
  newBrowserId,
  playwrightSnippet,
  saveSessions,
  type BrowserAction,
  type BrowserCapture,
  type BrowserSession,
} from "@/lib/browserLab";

const INPUT =
  "w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-line-strong";
const GHOST_BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover disabled:opacity-50";
const PRIMARY_BTN =
  "inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-50";

type Tab = "screenshot" | "dom" | "console" | "network" | "actions" | "code";

export default function BrowserLab() {
  const toast = useToast();
  const [url, setUrl] = useState("http://localhost:3000");
  const [viewport, setViewport] = useState("desktop");
  const [tab, setTab] = useState<Tab>("screenshot");
  const [capture, setCapture] = useState<BrowserCapture | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [live, setLive] = useState(false);
  const [sessions, setSessions] = useState<BrowserSession[]>(() => []);
  const [activeSession, setActiveSession] = useState<BrowserSession | null>(null);
  const [actionText, setActionText] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setSessions(loadSessions());
    setHydrated(true);
  }, []);

  const persistSessions = useCallback((next: BrowserSession[]) => {
    setSessions(next);
    saveSessions(next);
  }, []);

  const recordAction = useCallback(
    (kind: BrowserAction["kind"], label: string, detail?: string) => {
      const action: BrowserAction = { id: newBrowserId(), kind, label, detail, at: Date.now() };
      setActiveSession((current) => {
        if (!current) {
          const session: BrowserSession = { id: newBrowserId(), url, viewport, startedAt: Date.now(), actions: [action] };
          persistSessions([session, ...sessions]);
          return session;
        }
        const next = { ...current, actions: [...current.actions, action] };
        persistSessions([next, ...sessions.filter((s) => s.id !== current.id)]);
        return next;
      });
    },
    [persistSessions, sessions, url, viewport],
  );

  const startSession = () => {
    const clean = url.trim();
    if (!looksLikeUrl(clean)) {
      toast("error", "Invalid URL", "Start with http:// or https://");
      return;
    }
    const session: BrowserSession = { id: newBrowserId(), url: clean, viewport, startedAt: Date.now(), actions: [] };
    setActiveSession(session);
    persistSessions([session, ...sessions]);
    recordAction("goto", `Open ${clean}`, clean);
    setLive(true);
    toast("success", "Session started", clean);
  };

  const stopSession = () => {
    setLive(false);
    toast("info", "Session paused", "Capture is still available on demand.");
  };

  const runCapture = useCallback(async () => {
    if (!looksLikeUrl(url)) return;
    setCapturing(true);
    try {
      const res = await fetch("/api/browser-lab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, viewport }),
      });
      const data = (await res.json().catch(() => ({}))) as BrowserCapture & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Capture failed");
      setCapture(data);
      recordAction("screenshot", data.title || "Capture", data.finalUrl);
    } catch (err) {
      toast("error", "Capture failed", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setCapturing(false);
    }
  }, [url, viewport, recordAction, toast]);

  // "Live" = refresh the capture every 4 seconds while the session is on.
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!live) return;
    timerRef.current = setInterval(() => {
      void runCapture();
    }, 4000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [live, runCapture]);

  // Poll console/network only — screenshot refresh is the expensive part.
  useEffect(() => {
    if (!live) return;
    const poll = setInterval(() => {
      void runCapture();
    }, 8000);
    return () => clearInterval(poll);
  }, [live, runCapture]);

  const queuedActions = activeSession?.actions ?? [];
  const snippet = useMemo(() => playwrightSnippet(url, viewport, queuedActions), [url, viewport, queuedActions]);
  const errors = capture?.console.filter((e) => e.type === "error").length ?? 0;
  const failedReqs = capture?.network.filter((n) => n.failed).length ?? 0;

  const exportCapture = () => {
    if (!capture) return;
    const url2 = URL.createObjectURL(new Blob([JSON.stringify(capture, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url2;
    anchor.download = "browser-capture.json";
    anchor.click();
    URL.revokeObjectURL(url2);
  };

  const addQueueAction = (kind: BrowserAction["kind"]) => {
    const text = actionText.trim();
    if (kind === "type" && !text) {
      toast("error", "Type something first", "The action text field is empty.");
      return;
    }
    if (kind === "wait" && !text) {
      toast("error", "Wait milliseconds first", "e.g. 500");
      return;
    }
    if (kind === "click" && !text) {
      toast("error", "Selector first", "e.g. text=Load more");
      return;
    }
    const labels: Record<BrowserAction["kind"], string> = { click: "Click", type: "Type", wait: "Wait", screenshot: "Screenshot", goto: "Goto" };
    recordAction(kind, labels[kind] ?? kind, text || undefined);
    setActionText("");
  };

  if (!hydrated) {
    return <main className="flex min-h-0 flex-1 items-center justify-center text-[13px] text-ink-3">Loading…</main>;
  }

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-3">
        <h1 className="flex items-center gap-2 text-[16px] font-semibold">
          <Globe size={17} /> Browser Lab
        </h1>
        <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-3">
          <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-500" : "bg-ink-3"}`} aria-hidden="true" />
          {live ? "Live" : "Paused"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            value={viewport}
            onChange={(event) => setViewport(event.target.value)}
            aria-label="Viewport"
            className="rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[13px] text-ink outline-none"
          >
            {Object.entries(VIEWPORTS).map(([key, vp]) => (
              <option key={key} value={key}>
                {vp.label}
              </option>
            ))}
          </select>
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            aria-label="URL"
            placeholder="http://localhost:3000"
            className="w-64 rounded-lg border border-line bg-canvas px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-3"
          />
          {live ? (
            <button type="button" onClick={stopSession} className={GHOST_BTN}>
              <Square size={14} /> Stop
            </button>
          ) : (
            <button type="button" onClick={startSession} className={PRIMARY_BTN}>
              <Play size={14} /> Go live
            </button>
          )}
          <button type="button" onClick={() => void runCapture()} disabled={capturing || !looksLikeUrl(url)} className={GHOST_BTN} title="Capture screenshot, DOM, console and network now">
            <Camera size={14} /> {capturing ? "Capturing…" : "Capture"}
          </button>
          <button type="button" onClick={exportCapture} disabled={!capture} className={GHOST_BTN}>
            <Download size={14} /> Export
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Live viewport (iframe; only for sites that allow framing). */}
          <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
            {live && looksLikeUrl(url) ? (
              <iframe
                key={url}
                title="Live browser preview"
                src={url}
                sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups"
                className="h-full w-full border-0 bg-white"
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-ink-3">
                <Globe size={22} />
                <p>Press <strong className="font-medium text-ink-2">Go live</strong> to open the URL in the embedded browser.</p>
                <p className="max-w-sm text-center text-[12px]">Some sites block framing — then use <strong className="font-medium text-ink-2">Capture</strong> for the screenshot, DOM, console and network instead.</p>
              </div>
            )}
            <span className="absolute left-2 top-2 rounded bg-black/70 px-2 py-0.5 font-mono text-[11px] text-white">
              {VIEWPORTS[viewport]?.label ?? viewport}
            </span>
          </div>

          {/* Tabs */}
          <div className="border-t border-line bg-panel">
            <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-1.5" role="tablist" aria-label="Browser lab tabs">
              {(
                [
                  ["screenshot", `Screenshot${capture?.screenshot ? "" : ""}`],
                  ["dom", "DOM inspector"],
                  ["console", `Console${errors ? ` (${errors})` : ""}`],
                  ["network", `Network${failedReqs ? ` (${failedReqs})` : ""}`],
                  ["actions", `Actions (${queuedActions.length})`],
                  ["code", "Playwright"],
                ] as Array<[Tab, string]>
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  onClick={() => setTab(key)}
                  className={`rounded-lg px-2.5 py-1 text-[12.5px] outline-none transition focus-visible:ring-2 focus-visible:ring-brand/40 ${
                    tab === key ? "bg-hover font-medium text-ink" : "text-ink-3 hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
              <span className="ml-auto text-[12px] text-ink-3">
                {capture ? `${capture.title} · ${capture.finalUrl}` : "No capture yet"}
              </span>
            </div>

            <div className="h-56 overflow-auto bg-canvas p-3">
              {tab === "screenshot" && (
                <div className="h-full">
                  {capture?.screenshot ? (
                    <img src={capture.screenshot} alt={`Screenshot of ${capture.title}`} className="max-h-full rounded-lg border border-line object-contain" />
                  ) : (
                    <p className="text-[13px] text-ink-3">No screenshot yet — press Capture.</p>
                  )}
                  {capture && <p className="mt-2 text-[12px] text-ink-3">{captureSummary(capture)}</p>}
                </div>
              )}
              {tab === "dom" && (
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-2">
                  {capture ? capture.dom : "No DOM captured yet — press Capture."}
                </pre>
              )}
              {tab === "console" && (
                <ul className="space-y-1 font-mono text-[11.5px]">
                  {capture ? (
                    capture.console.length ? (
                      capture.console.map((entry, index) => (
                        <li key={index} className="flex gap-2">
                          <span className={`shrink-0 font-semibold ${entry.type === "error" ? "text-red-600 dark:text-red-400" : "text-ink-3"}`}>{entry.type}</span>
                          <span className="min-w-0 flex-1 break-words text-ink-2">{entry.text}</span>
                        </li>
                      ))
                    ) : (
                      <li className="text-ink-3">No console output.</li>
                    )
                  ) : (
                    <li className="text-ink-3">No capture yet — press Capture.</li>
                  )}
                </ul>
              )}
              {tab === "network" && (
                <ul className="space-y-1 font-mono text-[11.5px]">
                  {capture ? (
                    capture.network.length ? (
                      capture.network.map((entry, index) => (
                        <li key={index} className="flex gap-2">
                          <span className={`shrink-0 font-semibold ${entry.failed ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                            {entry.status || "ERR"}
                          </span>
                          <span className="shrink-0 text-ink-3">{entry.method}</span>
                          <span className="min-w-0 flex-1 break-words text-ink-2">{entry.url}</span>
                        </li>
                      ))
                    ) : (
                      <li className="text-ink-3">No network requests recorded.</li>
                    )
                  ) : (
                    <li className="text-ink-3">No capture yet — press Capture.</li>
                  )}
                </ul>
              )}
              {tab === "actions" && (
                <div className="grid gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <input
                      value={actionText}
                      onChange={(event) => setActionText(event.target.value)}
                      placeholder="Selector, text — or wait ms"
                      aria-label="Action detail"
                      className="w-56 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink-3"
                    />
                    <button type="button" onClick={() => addQueueAction("click")} className={GHOST_BTN}>+ Click</button>
                    <button type="button" onClick={() => addQueueAction("type")} className={GHOST_BTN}>+ Type</button>
                    <button type="button" onClick={() => addQueueAction("wait")} className={GHOST_BTN}>+ Wait</button>
                    <button type="button" onClick={() => addQueueAction("screenshot")} className={GHOST_BTN}>+ Screenshot</button>
                    <button
                      type="button"
                      onClick={() => {
                        const session = activeSession;
                        if (!session) return;
                        persistSessions([session, ...sessions.filter((s) => s.id !== session.id)]);
                        toast("success", "Session saved", session.url);
                      }}
                      disabled={!activeSession}
                      className={GHOST_BTN}
                    >
                      <History size={14} /> Save session
                    </button>
                  </div>
                  <ul className="space-y-1 text-[12.5px]">
                    {queuedActions.length === 0 ? (
                      <li className="text-ink-3">Queue Playwright steps here, then copy them from the Playwright tab.</li>
                    ) : (
                      queuedActions.map((action, index) => (
                        <li key={action.id} className="flex items-center gap-2">
                          <span className="shrink-0 tabular-nums text-ink-3">{index + 1}.</span>
                          <span className="font-medium text-ink">{action.label}</span>
                          {action.detail && <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-3">{action.detail}</span>}
                          <button
                            type="button"
                            onClick={() =>
                              setActiveSession((current) => (current ? { ...current, actions: current.actions.filter((a) => a.id !== action.id) } : current))
                            }
                            aria-label={`Remove step ${index + 1}`}
                            className="shrink-0 rounded px-1.5 py-0.5 text-ink-3 hover:bg-hover hover:text-ink"
                          >
                            ✕
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                </div>
              )}
              {tab === "code" && (
                <div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink-2">{snippet}</pre>
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard?.writeText(snippet).then(() => toast("success", "Copied")).catch(() => toast("error", "Copy failed"))}
                    className={`${GHOST_BTN} mt-2`}
                  >
                    <Code2 size={14} /> Copy snippet
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className="hidden w-64 shrink-0 overflow-y-auto border-l border-line bg-panel p-4 lg:block" aria-label="Sessions">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <History size={14} /> Sessions ({sessions.length})
          </p>
          {sessions.length === 0 ? (
            <p className="mt-2 text-[12px] text-ink-3">No saved sessions yet. Go live, queue actions, then save.</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {sessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveSession(session);
                      setUrl(session.url);
                      setViewport(session.viewport);
                    }}
                    className={`block w-full rounded-lg px-2 py-1.5 text-left outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40 ${
                      activeSession?.id === session.id ? "bg-hover" : ""
                    }`}
                  >
                    <span className="block truncate text-[13px] text-ink">{session.url}</span>
                    <span className="mt-0.5 block text-[11px] text-ink-3">
                      {session.actions.length} actions · {new Date(session.startedAt).toLocaleTimeString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => {
              persistSessions([]);
              setActiveSession(null);
              toast("success", "History cleared");
            }}
            disabled={sessions.length === 0}
            className={`${GHOST_BTN} mt-3 w-full justify-center disabled:opacity-50`}
          >
            <RefreshCw size={12} /> Clear history
          </button>
          <p className="mt-4 flex gap-1.5 text-[11.5px] text-ink-3">
            <Terminal size={12} className="mt-0.5 shrink-0" />
            Capture runs a headless Chromium on this app's server. The iframe is the same origin only — other sites may block framing.
          </p>
          <p className="mt-2 flex gap-1.5 text-[11.5px] text-ink-3">
            <Network size={12} className="mt-0.5 shrink-0" />
            Nothing is stored on the backend; sessions live in this browser.
          </p>
        </aside>
      </div>

      {/* Mobile history strip */}
      {sessions.length > 0 && (
        <div className="flex gap-2 overflow-x-auto border-t border-line bg-panel p-2 lg:hidden">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => {
                setActiveSession(session);
                setUrl(session.url);
                setViewport(session.viewport);
              }}
              className="shrink-0 rounded-lg border border-line px-2 py-1 text-[12px] text-ink-2"
            >
              {session.url.replace(/^https?:\/\//, "")} · {session.actions.length} steps
            </button>
          ))}
        </div>
      )}
    </main>
  );
}
