"use client"

import * as React from "react"
import { CircleCheckIcon, LoaderCircleIcon } from "lucide-react"
import { cn } from "cn"
import { reasoningForDisplay } from "@/api/convex/lib/chat/reasoningDisplay"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

type TraceStatus = "running" | "done" | undefined

function Trace({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="trace"
      className={cn("flex w-full flex-col gap-2 text-sm", className)}
      {...props}
    />
  )
}

function TraceCollapsible({
  className,
  ...props
}: React.ComponentProps<typeof Collapsible>) {
  return (
    <Collapsible
      data-slot="trace-collapsible"
      className={cn("flex w-full flex-col", className)}
      {...props}
    />
  )
}

function TraceCollapsibleTrigger({
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger
      data-slot="trace-collapsible-trigger"
      className={cn("w-full cursor-pointer text-left", className)}
      {...props}
    />
  )
}

function TraceCollapsibleContent({
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="trace-collapsible-content"
      className={cn(
        "text-muted-foreground whitespace-pre-wrap rounded-md border bg-gray-50 px-3 py-2 text-xs leading-relaxed dark:bg-gray-800/50",
        className
      )}
      {...props}
    />
  )
}

function TraceLine({
  className,
  status,
  children,
  ...props
}: React.ComponentProps<"div"> & { status?: TraceStatus }) {
  return (
    <div
      data-slot="trace-line"
      data-status={status}
      className={cn(
        "flex items-center gap-2 text-xs font-medium",
        status === "running"
          ? "text-gray-500 dark:text-gray-400"
          : "text-gray-600 dark:text-gray-300",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

function TraceIcon({
  className,
  children,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-icon"
      className={cn("flex size-4 shrink-0 items-center justify-center", className)}
      {...props}
    >
      {children ?? <CircleCheckIcon className="size-3.5" />}
    </span>
  )
}

function TraceTitle({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span data-slot="trace-title" className={cn("shrink-0", className)} {...props} />
  )
}

function TraceDescription({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-description"
      className={cn("text-muted-foreground font-normal tabular-nums", className)}
      {...props}
    />
  )
}

/**
 * One agent-reasoning line (à la shadcn "Reasoning"): "Thinking" while the
 * model streams, "Thought" when done, expandable to the reasoning text,
 * with the measured duration when the backend supplies it.
 */
export function ReasoningLine({
  text,
  running,
  seconds,
}: {
  text?: string;
  running?: boolean;
  seconds?: number;
}) {
  const [userOpen, setUserOpen] = React.useState<boolean | undefined>(undefined)
  const hasText = Boolean(reasoningForDisplay(text))
  const line = (
    <TraceLine status={running ? "running" : undefined}>
      <TraceIcon>
        {running ? (
          <LoaderCircleIcon className="animate-spin size-3.5" />
        ) : (
          <CircleCheckIcon className="size-3.5" />
        )}
      </TraceIcon>
      <TraceTitle className={running ? "thinking-shimmer" : undefined}>{running ? "Thinking" : "Thought"}</TraceTitle>
      {seconds && !running ? (
        <TraceDescription>{(seconds / 1000).toFixed(1)}s</TraceDescription>
      ) : null}
    </TraceLine>
  )

  if (!hasText) return <Trace>{line}</Trace>

  return (
    <Trace>
      <TraceCollapsible open={userOpen ?? running} onOpenChange={setUserOpen}>
        <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
        <TraceCollapsibleContent>{reasoningForDisplay(text)}</TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

export {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
  TraceDescription,
}
