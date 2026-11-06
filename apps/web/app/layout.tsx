import "./globals.css";
import "skullet/styles.css";
import ConvexClientProvider from "../lib/convex";
import { Geist, Inter, JetBrains_Mono } from "next/font/google";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "@/components/Toasts";
import { NewProjectProvider } from "@/components/NewProject";
import { SettingsProvider } from "@/components/Settings";
import { LlmSettingsProvider } from "@/components/LlmSettings";
import { ShellBackground } from "@/components/ui/background-snippets";
import Script from "next/script";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { SkulletProvider } from "skullet/react";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });

export const metadata = {
  title: "Agent Workspace",
  description: "Multi-agent workspace for planning, running, and reviewing tasks.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={cn("font-sans", geist.variable, inter.variable, jetbrains.variable)} data-font="geist">
      <body>
        <ShellBackground />
        <ThemeProvider>
        <SkulletProvider mode="system">
        <TooltipProvider>
          <ToastProvider>
        <ConvexClientProvider>
          <NewProjectProvider><SettingsProvider><LlmSettingsProvider>{children}</LlmSettingsProvider></SettingsProvider></NewProjectProvider>
        </ConvexClientProvider>
          </ToastProvider>
        </TooltipProvider>
        </SkulletProvider>
        </ThemeProvider>
        <Script src="/font-init.js" strategy="beforeInteractive" />
      </body>
    </html>
  );
}
