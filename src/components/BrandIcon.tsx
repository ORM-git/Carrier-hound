import React from "react";
import Image from "next/image";

export interface BrandIconProps {
  className?: string;
  size?: number;
  priority?: boolean;
  variant?: "legacy" | "new";
}

/**
 * CareerMonke Brand Logo Icon
 * - "legacy": Original vector SVG mascot used throughout app shells and internal pages.
 * - "new": High-res official CareerMonke mascot logo used on landing header, landing footer, and early-access.
 */
export default function BrandIcon({
  className = "w-6 h-6",
  size,
  priority = false,
  variant = "legacy",
}: BrandIconProps) {
  if (variant === "new") {
    return (
      <Image
        src="/logo.png"
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
    <img
      src="/careermonke.svg"
      alt="CareerMonke"
      width={size || 36}
      height={size || 36}
      className={`select-none object-contain ${className}`}
      draggable={false}
    />
  );
}
