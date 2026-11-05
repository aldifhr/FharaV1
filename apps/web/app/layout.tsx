import "./globals.css";
import ConvexClientProvider from "../lib/convex";

export const metadata = { title: "Agent Workspace" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}

