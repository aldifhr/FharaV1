import { cn } from "@/lib/utils";

export function ShellBackground({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none fixed inset-0 -z-10 overflow-hidden", className)}
    >
      <div className="absolute inset-0 bg-[#f7f7fb] dark:bg-[#06060b]" />

      <div className="absolute inset-0 bg-[linear-gradient(to_right,#8080800f_1px,transparent_1px),linear-gradient(to_bottom,#8080800f_1px,transparent_1px)] bg-[size:14px_24px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,#000_55%,transparent_100%)] dark:hidden" />
      <div className="absolute inset-0 hidden bg-[linear-gradient(to_right,#ffffff0a_1px,transparent_1px),linear-gradient(to_bottom,#ffffff0a_1px,transparent_1px)] bg-[size:14px_24px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,#000_55%,transparent_100%)] dark:block" />

      <div className="absolute left-1/2 top-[-200px] h-[440px] w-[780px] -translate-x-1/2 rounded-full bg-[#6252d8]/15 blur-[120px] dark:bg-[#6252d8]/25" />
      <div className="absolute bottom-[-240px] right-[-140px] h-[460px] w-[460px] rounded-full bg-[#38bdf8]/10 blur-[130px]" />
      <div className="absolute bottom-[-200px] left-[-160px] h-[380px] w-[380px] rounded-full bg-[#f472b6]/10 blur-[120px] dark:bg-[#f472b6]/15" />
    </div>
  );
}
