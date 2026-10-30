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
 * Official CareerMonke mascot logo used across website headers, footers, rails, and pages.
 */
export default function BrandIcon({
  className = "w-6 h-6",
  size,
  priority = false,
  variant,
}: BrandIconProps) {
  const pixelSize = size || 48;
  return (
    <Image
      src="/logo.png"
      alt="CareerMonke"
      width={pixelSize}
      height={pixelSize}
      className={`select-none object-contain ${className}`}
      draggable={false}
      priority={priority}
    />
  );
}
