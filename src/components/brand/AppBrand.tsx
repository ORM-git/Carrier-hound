/**
 * src/components/brand/AppBrand.tsx: APP-ONLY CareerMonke brand contract (Agent A).
 * Never import this from the landing page, public header/footer, root layout or global CSS: the landing
 * keeps its existing logo and colours unchanged. Contract and measured contrast: docs/brand-audit.md.
 */
import React from "react";
import Image from "next/image";

/**
 * Interim wordmark: an exact pixel crop of the owner-supplied file (opaque Deep Blue on #FEFEFE, not transparent).
 * shortcut: opaque interim crop, so use it on white/near-white surfaces only; swap `src` when the owner's
 * transparent SVG/PNG arrives (nothing else changes).
 */
export const WORDMARK = { src: "/brand/careermonke-wordmark-interim.png", width: 1543, height: 186, alt: "CareerMonke" } as const;

/** Rendered heights (px) per app placement. Width follows the asset ratio: stable box, never clipped. */
export const WORDMARK_HEIGHT = { header: 20, rail: 20, drawer: 22, footer: 24, loading: 32 } as const;
export type WordmarkPlacement = keyof typeof WORDMARK_HEIGHT;
export const wordmarkWidth = (p: WordmarkPlacement) => Math.round((WORDMARK_HEIGHT[p] * WORDMARK.width) / WORDMARK.height);

/** The one app logo. Wide slots only: there is no approved square/compact mark, so never squeeze it into an icon. */
export function BrandWordmark({ placement, priority = false, className = "" }: { placement: WordmarkPlacement; priority?: boolean; className?: string }) {
  const h = WORDMARK_HEIGHT[placement];
  const w = wordmarkWidth(placement);
  return (
    <Image
      src={WORDMARK.src}
      alt={WORDMARK.alt}
      width={w}
      height={h}
      style={{ width: w, height: h }}
      className={`block shrink-0 max-w-none select-none ${className}`}
      draggable={false}
      priority={priority}
    />
  );
}

/**
 * App colour tokens (owner V4): Electric is the single primary accent; Royal is hover/pressed; Deep is strong text.
 * White small text on Electric is 3.73:1 (fails), so the primary foreground is ink #0F172A (4.79:1). On Royal it
 * flips to white (7.23:1). Active/selected text is Deep on the selected fill (10.10:1).
 */
export const APP_BRAND = {
  primary: "#0082FF",
  onPrimary: "#0F172A",
  primaryHover: "#0039F5",
  onPrimaryHover: "#FFFFFF",
  strong: "#0020B0",
  accent: "#0082FF",
  selected: "#E6F2FF",
  border: "#A6D3FF",
} as const;

/** Scoped CSS variables for app page content: spread onto an app-only wrapper, e.g. <div style={APP_BRAND_VARS}>. */
export const APP_BRAND_VARS = {
  "--cm-app-primary": APP_BRAND.primary,
  "--cm-app-on-primary": APP_BRAND.onPrimary,
  "--cm-app-primary-hover": APP_BRAND.primaryHover,
  "--cm-app-on-primary-hover": APP_BRAND.onPrimaryHover,
  "--cm-app-strong": APP_BRAND.strong,
  "--cm-app-accent": APP_BRAND.accent,
  "--cm-app-selected": APP_BRAND.selected,
  "--cm-app-border": APP_BRAND.border,
} as React.CSSProperties;
