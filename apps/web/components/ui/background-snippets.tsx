import { cn } from "@/lib/utils";

export function ShellBackground({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none fixed inset-0 -z-10 overflow-hidden", className)}
    >
      <div className="absolute inset-0 bg-[#f7f7fb] dark:bg-[#06060b]" />
    </div>
  );
}
