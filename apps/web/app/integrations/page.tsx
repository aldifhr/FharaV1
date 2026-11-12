"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { IntegrationsPanel } from "@/components/integrations/IntegrationsPanel";

/**
 * Integrations page: the same panel as Settings → Integrations, with the app
 * sidebar. The page owns the shell and the `?project=` scope (the panel writes
 * it back), so the panel stays free of a Sidebar import.
 */
function IntegrationsPage() {
  const projectId = useSearchParams().get("project") ?? undefined;
  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <Sidebar projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <IntegrationsPanel />
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p className="px-6 py-10 text-[13px] text-ink-3" role="status">Loading integrations…</p>}>
      <IntegrationsPage />
    </Suspense>
  );
}
