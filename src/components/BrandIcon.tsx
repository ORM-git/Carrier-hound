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
 * CareerMonke Brand Logo & Mascot Icon
 * - "full": Full official logo image (mascot monkey head with sunglasses + "career monke" wordmark).
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
    const w = width || 140;
    const h = height || 56;
    return (
      <Image
        src="/careermonke-logo.png"
        alt="CareerMonke"
        width={w}
        height={h}
        className={`select-none object-contain ${className}`}
        draggable={false}
        priority={priority}
      />
    );
  }

  if (variant === "new") {
    return (
      <Image
        src="/icon.png"
        alt="CareerMonke"
        width={size || 48}
        height={size || 48}
        className={`select-none object-contain ${className}`}
        draggable={false}
        priority={priority}
      />
    );
  }

  return (
    <Image
      src="/icon.png"
      alt="CareerMonke"
      width={size || 36}
      height={size || 36}
      className={`select-none object-contain ${className}`}
      draggable={false}
      priority={priority}
    />
  );
}
