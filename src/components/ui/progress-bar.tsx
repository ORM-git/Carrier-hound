import * as React from "react";
import { cnTokens } from "./cn-tokens";

export type ProgressTone = "brand" | "success" | "warning" | "danger";

const FILLS: Record<ProgressTone, string> = {
  brand: "bg-brand-600",
  success: "bg-success-600",
  warning: "bg-warning-500",
  danger: "bg-danger-600",
};

export interface ProgressBarProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  /** Current value (clamped to 0..max). */
  value: number;
  max?: number;
  tone?: ProgressTone;
  size?: "sm" | "md";
  /** Accessible name. Required unless aria-labelledby is supplied. */
  label?: string;
  /** Render the label + percentage above the bar. */
  showValue?: boolean;
}

/**
 * Determinate progress bar. The fill animates with transform: scaleX only
 * (no width/layout animation) and respects prefers-reduced-motion via tokens.
 */
export function ProgressBar({
  value,
  max = 100,
  tone = "brand",
  size = "md",
  label,
  showValue = false,
  className,
  ...props
}: ProgressBarProps) {
  const safeMax = max > 0 ? max : 100;
  const clamped = Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), safeMax);
  const ratio = clamped / safeMax;
  const pct = Math.round(ratio * 100);

  return (
    <div className={cnTokens("w-full", className)}>
      {showValue && (
        <div className="mb-tk-half flex items-center justify-between text-tk-caption text-ink-muted">
          {label && <span className="font-medium">{label}</span>}
          <span className="tabular-nums font-semibold text-ink">{pct}%</span>
        </div>
      )}
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={clamped}
        aria-valuetext={`${pct}%`}
        className={cnTokens(
          "relative w-full overflow-hidden rounded-tk-full bg-surface-sunken",
          size === "sm" ? "h-1.5" : "h-2.5"
        )}
        {...props}
      >
        <div
          className={cnTokens(
            "absolute inset-0 origin-left rounded-tk-full transition-transform duration-tk-slow ease-tk-entrance",
            FILLS[tone]
          )}
          style={{ transform: `scaleX(${ratio})` }}
        />
      </div>
    </div>
  );
}

export default ProgressBar;
