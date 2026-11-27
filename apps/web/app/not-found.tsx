import { Link } from "@/lib/spaRouter";
import { ArrowRight, Compass, Inbox, Search } from "lucide-react";

/**
 * Shown by the SPA's catch-all route in src/main.tsx for an unmatched URL.
 * It renders inside the app's providers, so it keeps the theme and tokens. A
 * missing page is not an error, so there is no retry — only a way back.
 */
const destinations = [
  { href: "/", label: "Overview", detail: "Your workspace at a glance", icon: Compass },
  { href: "/search", label: "Search", detail: "Find a project, task, or agent", icon: Search },
  { href: "/inbox", label: "Inbox", detail: "Approvals and what needs you", icon: Inbox },
];

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-5 py-12 text-ink">
      <div className="w-full max-w-lg">
        <section className="rounded-panel border border-line bg-panel p-7 shadow-sm max-sm:p-5">
          <span className="flex h-11 w-11 items-center justify-center rounded-field bg-brand-soft text-brand">
            <Compass size={21} strokeWidth={1.6} aria-hidden="true" />
          </span>

          <div className="mt-6 flex items-end gap-3">
            <p aria-hidden="true" className="font-mono text-[56px] font-semibold leading-none tracking-tight text-ink max-sm:text-[44px]">
              404
            </p>
            <span className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-3">Route not found</span>
          </div>

          <h1 className="mt-4 text-[22px] font-semibold tracking-tight">This page isn&apos;t here</h1>
          <p className="mt-2 max-w-md text-[14px] leading-relaxed text-ink-2">
            The link may be out of date, or the page may have moved. Nothing was lost — choose where to go next.
          </p>

          <nav aria-label="Suggested destinations" className="mt-7 border-t border-line pt-2">
            <ul className="divide-y divide-line">
              {destinations.map(({ href, label, detail, icon: Icon }) => (
                <li key={href}>
                  <Link
                    href={href}
                    className="group -mx-2 flex items-center gap-3 rounded-field px-2 py-2.5 outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40"
                  >
                    <Icon size={17} strokeWidth={1.6} className="shrink-0 text-ink-3 transition group-hover:text-brand" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-medium text-ink">{label}</span>
                      <span className="block text-[12.5px] text-ink-3">{detail}</span>
                    </span>
                    <ArrowRight
                      size={15}
                      strokeWidth={1.6}
                      className="shrink-0 text-ink-3 opacity-0 transition group-hover:translate-x-0.5 group-hover:text-brand group-hover:opacity-100 group-focus-visible:opacity-100"
                      aria-hidden="true"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </section>

        <p className="mt-5 text-center text-[12px] text-ink-3">
          If this link came from somewhere else, let whoever shared it know it no longer works.
        </p>
      </div>
    </main>
  );
}
