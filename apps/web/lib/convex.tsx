"use client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { useState } from "react";

export default function ConvexClientProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL missing — copy .env.example to .env");
    return new ConvexReactClient(url);
  });
  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}

