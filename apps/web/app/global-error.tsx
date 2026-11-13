"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";

/**
 * Last-resort boundary: catches a throw in the root layout itself, where
 * `app/error.tsx` cannot help. Next replaces the whole document with this file,
 * so it must render `<html>`/`<body>` and carry its own styles (global CSS and
 * the theme class are not applied here) — hence inline CSS with a
 * `prefers-color-scheme` pair instead of Tailwind tokens.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const message = error instanceof Error ? error.message : "";

  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <style>{`
          :root { color-scheme: light dark; }
          .app-fatal {
            min-height: 100dvh; display: flex; align-items: center; justify-content: center;
            padding: 24px; background: #fafafa; color: #18181b;
            font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
          }
          .app-fatal-card {
            width: 100%; max-width: 28rem; padding: 24px; text-align: center;
            border: 1px solid #e4e4e7; border-radius: 12px; background: #fff;
          }
          .app-fatal h1 { margin: 0; font-size: 16px; font-weight: 600; }
          .app-fatal p { margin: 8px 0 0; font-size: 14px; color: #52525b; }
          .app-fatal pre {
            margin: 12px 0 0; padding: 8px 12px; max-height: 6rem; overflow: auto; text-align: left;
            font-size: 12px; border-radius: 8px; background: #f4f4f5; color: #52525b;
          }
          .app-fatal button {
            margin-top: 20px; padding: 8px 16px; font: inherit; font-size: 14px; font-weight: 500;
            color: #18181b; background: #fff; border: 1px solid #e4e4e7; border-radius: 8px; cursor: pointer;
          }
          .app-fatal button:hover { background: #f4f4f5; }
          @media (prefers-color-scheme: dark) {
            .app-fatal { background: #09090b; color: #fafafa; }
            .app-fatal-card { background: #18181b; border-color: #27272a; }
            .app-fatal p { color: #a1a1aa; }
            .app-fatal pre { background: #27272a; color: #a1a1aa; }
            .app-fatal button { background: #18181b; color: #fafafa; border-color: #27272a; }
            .app-fatal button:hover { background: #27272a; }
          }
        `}</style>
        <div className="app-fatal">
          <div className="app-fatal-card">
            <h1>The app failed to load</h1>
            <p>A fatal error stopped the interface from starting.</p>
            {message && <pre>{message}</pre>}
            <button type="button" onClick={() => retry()}>
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
