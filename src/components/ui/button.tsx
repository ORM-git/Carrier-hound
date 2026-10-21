import * as React from "react";
import { Loader2 } from "lucide-react";
import { cnTokens } from "./cn-tokens";

export type ButtonVariant = "primary" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-tk-1 whitespace-nowrap font-semibold select-none " +
  "rounded-tk-lg transition-[background-color,color,box-shadow,transform] duration-tk-fast ease-tk-standard " +
  "focus-visible:outline-none focus-visible:shadow-tk-focus " +
  "disabled:cursor-not-allowed disabled:opacity-60 motion-safe:active:scale-[0.98] cursor-pointer";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-600 text-ink-inverse shadow-tk-sm hover:bg-brand-700 disabled:hover:bg-brand-600",
  ghost:
    "bg-transparent text-ink-muted hover:bg-surface-muted hover:text-ink disabled:hover:bg-transparent",
  destructive:
    "bg-danger-600 text-ink-inverse shadow-tk-sm hover:bg-danger-700 disabled:hover:bg-danger-600",
};

// Every size meets the 44px touch-target minimum except `sm` (40px), which is
// intended for dense desktop toolbars only.
const SIZES: Record<ButtonSize, string> = {
  sm: "h-10 px-tk-2 text-tk-body-sm",
  md: "h-11 px-tk-2 text-tk-body-sm",
  lg: "h-12 px-tk-3 text-tk-body",
};

/** Shared class builder so `<Link>`/`<a>` elements can look like buttons. */
export function buttonClasses({
  variant = "primary",
  size = "md",
  fullWidth = false,
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
} = {}) {
  return cnTokens(BASE, VARIANTS[variant], SIZES[size], fullWidth && "w-full", className);
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Shows a spinner, sets aria-busy and blocks clicks. Width is preserved. */
  loading?: boolean;
  /** Optional accessible text announced while loading (defaults to "Loading"). */
  loadingLabel?: string;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    fullWidth = false,
    loading = false,
    loadingLabel = "Loading",
    disabled,
    className,
    children,
    type = "button",
    ...props
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, fullWidth, className })}
      {...props}
    >
      {loading && (
        <>
          <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" />
          <span className="sr-only">{loadingLabel}</span>
        </>
      )}
      {children}
    </button>
  );
});
