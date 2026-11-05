import "./globals.css";
import ConvexClientProvider from "../lib/convex";
import { Geist, Inter, JetBrains_Mono } from "next/font/google";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "@/components/Toasts";
import { ShellBackground } from "@/components/ui/background-snippets";

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
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('moagent-theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;if(d){document.documentElement.classList.add('dark');}var f=localStorage.getItem('moagent-font');var ok=['geist','inter','system','jetbrains'];document.documentElement.setAttribute('data-font',ok.indexOf(f)>=0?f:'geist');}catch(e){}})();`,
          }}
        />
        <TooltipProvider>
          <ToastProvider>
            <ConvexClientProvider>{children}</ConvexClientProvider>
          </ToastProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
