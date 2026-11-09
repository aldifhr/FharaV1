import "./globals.css";
import "skullet/styles.css";
import ConvexClientProvider from "@/lib/convex";
import { Geist, Inter, JetBrains_Mono } from "next/font/google";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "@/components/Toasts";
import { NewProjectProvider } from "@/components/NewProject";
import { SettingsProvider } from "@/components/Settings";
import { LlmSettingsProvider } from "@/components/LlmSettings";
import { ShellBackground } from "@/components/ui/background-snippets";
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
    <html lang="en" suppressHydrationWarning className={cn("font-sans", geist.variable, inter.variable, jetbrains.variable)} data-font="inter">
      <head>
        {/* One-time migration of pre-rebrand localStorage keys (moagent* -> fhara*),
            then apply the theme before first paint: without this, dark-mode users
            saw a white flash on every load (ThemeProvider runs after paint). */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{for(var i=localStorage.length-1;i>=0;i--){var k=localStorage.key(i);if(k&&k.indexOf('moagent')===0){var n='fhara'+k.slice(7);if(localStorage.getItem(n)===null)localStorage.setItem(n,localStorage.getItem(k));localStorage.removeItem(k)}}}catch(e){}try{var t=localStorage.getItem('theme');var d=t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.classList.toggle('dark',d);r.setAttribute('data-theme',d?'dark':'light');r.style.colorScheme=d?'dark':'light';var f=localStorage.getItem('fhara-font');if(f)r.setAttribute('data-font',f)}catch(e){}",
          }}
        />
      </head>
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
      </body>
    </html>
  );
}
