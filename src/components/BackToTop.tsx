"use client";

import React, { useEffect, useState } from "react";
import { ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePathname } from "next/navigation";

export default function BackToTop() {
  const pathname = usePathname();
  // Onboarding owns a fixed bottom action bar. Keep this optional shortcut out
  // of that flow rather than placing another floating control over its Next CTA.
  const isOnboarding = pathname === "/onboarding" || pathname?.startsWith("/onboarding/");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isOnboarding) return;
    const handleScroll = () => {
      if (window.scrollY > 300) {
        setVisible(true);
      } else {
        setVisible(false);
      }
    };

    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [isOnboarding]);

  const scrollToTop = () => {
    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  };

  if (isOnboarding || !visible) return null;

  return (
    <button
      onClick={scrollToTop}
      aria-label="Back to top"
      className={cn(
        "fixed right-[32px] bottom-[24px] md:bottom-[32px] z-40 w-[40px] h-[40px] rounded-[6px] bg-[#2563EB] text-white flex items-center justify-center shadow-lg transition-all duration-200 hover:bg-[#1D4ED8] focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:ring-offset-2 cursor-pointer animate-in fade-in zoom-in-75"
      )}
    >
      <ChevronUp className="w-5 h-5 stroke-[2.5]" />
    </button>
  );
}
