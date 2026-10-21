import * as React from "react";
import { cnTokens } from "./cn-tokens";

export type BadgeTone = "neutral" | "brand" | "success" | "warning" | "danger";
export type BadgeSize = "sm" | "md";

// All text/background pairs below are verified >= 4.5:1 by scripts/test-design-tokens.ts.
const TONES: Record<BadgeTone, { box: string; dot: string }> = {
  neutral: { box: "bg-surface-muted text-ink-muted border-line", dot: "bg-ink-subtle" },
  brand: { box: "bg-brand-50 text-brand-700 border-brand-200", dot: "bg-brand-600" },
  success: { box: "bg-success-50 text-success-700 border-success-100", dot: "bg-success-500" },
  warning: { box: "bg-warning-50 text-warning-700 border-warning-100", dot: "bg-warning-500" },
  danger: { box: "bg-danger-50 text-danger-700 border-danger-100", dot: "bg-danger-600" },
};

const SIZES: Record<BadgeSize, string> = {
  sm: "h-5 px-tk-1 text-[11px] leading-none gap-1",
  md: "h-6 px-tk-1 text-tk-caption gap-1.5",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: BadgeSize;
  /** Leading status dot. */
  dot?: boolean;
}

export function Badge({ tone = "neutral", size = "md", dot = false, className, children, ...props }: BadgeProps) {
  const t = TONES[tone];
  return (
    <span
      className={cnTokens(
        "inline-flex items-center whitespace-nowrap rounded-tk-full border font-semibold",
        t.box,
        SIZES[size],
        className
      )}
      {...props}
    >
      {dot && <span aria-hidden="true" className={cnTokens("h-1.5 w-1.5 shrink-0 rounded-tk-full", t.dot)} />}
      {children}
    </span>
  );
}

export default Badge;
