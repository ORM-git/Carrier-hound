import React from "react";
import { cn } from "@/lib/utils";

interface ChipProps {
  children: React.ReactNode;
  variant?: "default" | "selected" | "light" | "salary" | "source" | "blue" | "outline";
  className?: string;
  onClick?: () => void;
}

export default function Chip({
  children,
  variant = "default",
  className,
  onClick,
}: ChipProps) {
  const variantStyles = {
    default: "bg-[#F1F5F9] border-[#E2E8F0] text-[#0F172A]",
    selected: "bg-[#DBEAFE] border-[#BFDBFE] text-[#1E3A8A] font-medium",
    light: "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8] font-medium",
    salary: "bg-[#DCFCE7] border-[#DCFCE7] text-[#16A34A] font-medium",
    source: "bg-[#F1F5F9] border-[#E2E8F0] text-[#475569]",
    blue: "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8] font-medium",
    outline: "bg-transparent border-[#CBD5E1] text-[#0F172A] hover:border-[#93C5FD]",
  };

  const isInteractive = !!onClick;

  return (
    <span
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium leading-none transition-all duration-200 ease-[cubic-bezier(0.645,0.045,0.355,1)]",
        variantStyles[variant],
        isInteractive && "cursor-pointer hover:opacity-80",
        className
      )}
    >
      {children}
    </span>
  );
}
