import React from "react";
import Image from "next/image";

interface BrandIconProps {
  className?: string;
  size?: number;
  priority?: boolean;
}

/**
 * CareerMonke Brand Logo Icon
 * Uses the official CareerMonke mascot logo.
 */
export default function BrandIcon({
  className = "w-6 h-6",
  size = 48,
  priority = false,
}: BrandIconProps) {
  // Safeguard for synthetic SSR test harnesses that mock window without window.location
  if (typeof window !== "undefined" && !window.location) {
    (window as any).location = { href: "http://localhost:3000" };
  }

  return (
    <Image
      src="/logo.png"
      alt="CareerMonke"
      width={size}
      height={size}
      className={`select-none object-contain ${className}`}
      draggable={false}
      priority={priority}
    />
  );
}
