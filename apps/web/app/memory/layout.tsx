import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Memory",
  description: "Notes agents carry between runs: conventions, decisions, and context you would otherwise repeat.",
};

export default function MemoryLayout({ children }: { children: ReactNode }) {
  return children;
}
