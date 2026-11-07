"use client"

import * as React from "react"
import { cn } from "cn"

const ChartContainer = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & { config: Record<string, unknown> }
>(({ config, className, children, ...props }, ref) => {
  return (
    <div
      ref={ref}
      data-chart={config ? Object.keys(config).join("|") : undefined}
      className={cn("relative aspect-auto h-[250px] w-full", className)}
      {...props}
    >
      {children}
    </div>
  )
})
ChartContainer.displayName = "ChartContainer"

const ChartTooltip = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    content?: React.ReactNode
    cursor?: boolean
  }
>(({ className, content, cursor, ...props }, ref) => {
  return (
    <div ref={ref} className={cn("relative", className)} {...props}>
      {content}
    </div>
  )
})
ChartTooltip.displayName = "ChartTooltip"

const ChartLegend = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    content?: React.ReactNode
  }
>(({ className, content, ...props }, ref) => {
  return (
    <div ref={ref} className={cn("flex flex-wrap gap-4", className)} {...props}>
      {content}
    </div>
  )
})
ChartLegend.displayName = "ChartLegend"

export { ChartContainer, ChartTooltip, ChartLegend }
