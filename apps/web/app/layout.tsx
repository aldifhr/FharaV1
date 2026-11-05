import "./globals.css";
import ConvexClientProvider from "../lib/convex";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "@/components/Toasts";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata = { title: "Agent Workspace" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={cn("font-sans", geist.variable)}>
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('moagent-theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;if(d){document.documentElement.classList.add('dark');}}catch(e){}})();`,
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
