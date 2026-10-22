import * as React from "react"

import { cn } from "@/lib/utils"
import { cnTokens } from "./cn-tokens"

/**
 * `legacy` (default) preserves the original shadcn styling used by existing
 * consumers (e.g. marquee-01). Token variants are opt-in:
 *  - `surface`:     flat white card with hairline border
 *  - `elevated`:    soft layered shadow
 *  - `interactive`: elevated + subtle hover lift (transform only, reduced-motion safe)
 */
export type CardVariant = "legacy" | "surface" | "elevated" | "interactive"

const TOKEN_CARD_BASE = "rounded-tk-xl border border-line bg-surface text-ink"
const TOKEN_CARD_VARIANTS: Record<Exclude<CardVariant, "legacy">, string> = {
  surface: "shadow-none ring-1 ring-[#E2E8F0]",
  elevated: "shadow-tk-md",
  interactive:
    "shadow-tk-sm transition-[transform,box-shadow] duration-tk-base ease-tk-entrance hover:shadow-tk-lg motion-safe:hover:-translate-y-0.5",
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
