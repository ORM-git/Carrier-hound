import * as React from "react"

import { cn } from "@/lib/utils"
import { cnTokens } from "./cn-tokens"

/**
 * `legacy` preserves the original shadcn styling used by landing page components (e.g. marquee-01).
 * Token variants:
 *  - `surface`:     flat white card with 16px radius and 1px #E2E8F0 ring, no drop shadow, 16-24px padding
 *  - `elevated`:    flat white card with 16px radius and 1px #E2E8F0 ring, no drop shadow, 16-24px padding
 *  - `interactive`: 16px radius card with 0.2s hover transition
 */
export type CardVariant = "legacy" | "surface" | "elevated" | "interactive"

const TOKEN_CARD_BASE = "rounded-[16px] border border-[#E2E8F0] ring-1 ring-[#E2E8F0] bg-white text-[#0F172A] shadow-none"
const TOKEN_CARD_VARIANTS: Record<Exclude<CardVariant, "legacy">, string> = {
  surface: "p-4 sm:p-6",
  elevated: "p-4 sm:p-6",
  interactive:
    "p-4 sm:p-6 transition-all duration-200 ease-[cubic-bezier(0.645,0.045,0.355,1)] motion-safe:hover:-translate-y-0.5",
}

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { variant?: CardVariant }
>(({ className, variant = "legacy", ...props }, ref) => (
  <div
    ref={ref}
    className={
      variant === "legacy"
        ? cn(
            "rounded-lg border bg-card text-card-foreground shadow-sm",
            className,
          )
        : cnTokens(TOKEN_CARD_BASE, TOKEN_CARD_VARIANTS[variant], className)
    }
    {...props}
  />
))
Card.displayName = "Card"

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-6", className)}
    {...props}
  />
))
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn(
      "text-2xl font-semibold leading-none tracking-tight",
      className,
    )}
    {...props}
  />
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-6 pt-0", className)}
    {...props}
  />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
