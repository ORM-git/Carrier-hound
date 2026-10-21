import * as React from "react";
import { cnTokens } from "./cn-tokens";

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Shape preset. Pass explicit width/height via className to match final layout (no CLS). */
  shape?: "block" | "text" | "circle";
}

/**
 * Placeholder block. Decorative (aria-hidden); wrap a group of skeletons in a
 * container with `role="status"` + `aria-label` to announce loading once.
 * Pulse is opacity-only and disabled under prefers-reduced-motion.
 */
export function Skeleton({ shape = "block", className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cnTokens(
        "bg-surface-muted motion-safe:animate-tk-skeleton",
        shape === "circle" ? "rounded-tk-full" : shape === "text" ? "h-3.5 rounded-tk-xs" : "rounded-tk-md",
        className
      )}
      {...props}
    />
  );
}

export default Skeleton;
