import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { FharaRuntimeProvider, FharaRuntimeReactClient } from "@fhara/runtime/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "@/components/Toasts";
import { NewProjectProvider } from "@/components/NewProject";
import { SettingsProvider } from "@/components/Settings";
import { ShellBackground } from "@/components/ui/background-snippets";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { SkulletProvider } from "skullet/react";
import "../app/globals.css";
import "skullet/styles.css";

const pages = import.meta.glob("../app/**/page.tsx", { eager: true }) as Record<
  string,
  { default: React.ComponentType }
>;

function routePath(file: string): string | null {
  if (file.includes("/api/")) return null;
  const relative = file.replace("../app/", "").replace("/page.tsx", "").replace("page.tsx", "");
  const segments = relative
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith("[") && segment.endsWith("]") ? `:${segment.slice(1, -1)}` : segment
    );
  return "/" + segments.join("/");
}

function App() {
  const client = React.useMemo(() => new FharaRuntimeReactClient(), []);
  return (
    <ThemeProvider>
      <SkulletProvider mode="system">
        <TooltipProvider>
          <ToastProvider>
            <FharaRuntimeProvider client={client}>
              <NewProjectProvider>
                <SettingsProvider>
                  <ShellBackground />
                  <Routes>
                    {Object.entries(pages).map(([file, module]) => {
                      const path = routePath(file);
                      if (!path) return null;
                      const Page = module.default;
                      return <Route key={file} path={path} element={<Page />} />;
                    })}
                    <Route path="*" element={<div className="p-8 text-ink">Page not found</div>} />
                  </Routes>
                </SettingsProvider>
              </NewProjectProvider>
            </FharaRuntimeProvider>
          </ToastProvider>
        </TooltipProvider>
      </SkulletProvider>
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
