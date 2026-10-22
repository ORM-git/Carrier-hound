import * as React from "react";
import { Loader2 } from "lucide-react";
import { cnTokens } from "./cn-tokens";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-tk-1 whitespace-nowrap font-medium select-none " +
  "rounded-full transition-all duration-200 ease-[cubic-bezier(0.645,0.045,0.355,1)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] focus-visible:ring-offset-1 " +
  "disabled:cursor-not-allowed disabled:opacity-60 motion-safe:active:scale-[0.98] cursor-pointer";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-[#2563EB] text-white hover:bg-[#1D4ED8] active:bg-[#1E40AF] disabled:hover:bg-[#2563EB]",
  secondary:
    "bg-[#F1F5F9] text-[#0F172A] hover:bg-[#E2E8F0] active:bg-[#CBD5E1] disabled:hover:bg-[#F1F5F9]",
  outline:
    "bg-white text-[#0F172A] border border-[#CBD5E1] hover:border-[#93C5FD] hover:bg-[#F8FAFC] active:bg-[#EFF6FF] disabled:hover:bg-white disabled:hover:border-[#CBD5E1]",
  ghost:
    "bg-transparent text-[#475569] hover:bg-[#F1F5F9] hover:text-[#0F172A] disabled:hover:bg-transparent",
  destructive:
    "bg-danger-600 text-ink-inverse shadow-tk-sm hover:bg-danger-700 disabled:hover:bg-danger-600",
};

// All 40px high (44px on touch) with 0.2s hover transition
const SIZES: Record<ButtonSize, string> = {
  sm: "h-10 min-h-[44px] sm:min-h-[40px] px-3.5 text-[14px]",
  md: "h-10 min-h-[44px] sm:min-h-[40px] px-4 text-[14px]",
  lg: "h-10 min-h-[44px] sm:min-h-[40px] px-5 text-[14px]",
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
