import React from "react";
import Image from "next/image";

export interface BrandIconProps {
  className?: string;
  size?: number;
  width?: number;
  height?: number;
  priority?: boolean;
  variant?: "legacy" | "new" | "full";
}

/**
 * Career Monke Brand Logo & Mascot Icon
 * - "full": Final brand wordmark ("career monke", 534x232, wide blue logo).
 * - "new" / "legacy": Mascot monkey head square icon for round buttons, avatars, and app rails.
 */
export default function BrandIcon({
  className = "w-6 h-6",
  size,
  width,
  height,
  priority = false,
  variant = "legacy",
}: BrandIconProps) {
  if (variant === "full") {
    // The final wordmark is wide (534x232, ratio ~2.30), so width derives from the
    // requested height: every call site keeps its height and the wordmark is not squashed.
    const h = height || 80;
    const w = Math.round(h * (534 / 232));
    return (
      <Image
        src="/careermonke-logo.png"
        alt="Career Monke"
        width={w}
        height={h}
        className={`select-none object-contain ${className}`}
        draggable={false}
        priority={priority}
      />
    );
  }

  const w = width || size || (variant === "new" ? 48 : 36);
  const h = height || size || (variant === "new" ? 48 : 36);

  return (
    <Image
      src="/icon.png"
      alt="Career Monke"
      width={w}
      height={h}
      className={`select-none object-contain ${className}`}
      draggable={false}
      priority={priority}
    />
  );
}
