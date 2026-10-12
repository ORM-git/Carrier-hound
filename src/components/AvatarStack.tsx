import React from "react";
import Image from "next/image";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface AvatarStackProps {
  className?: string;
  peopleCount?: string;
  jobsCount?: string;
  textColor?: string;
}

const AVATAR_URLS = [
  "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?auto=format&fit=crop&w=96&h=96&q=75",
];

export default function AvatarStack({
  className,
  peopleCount = "8,573",
  jobsCount = "4.5 million",
  textColor = "text-white",
}: AvatarStackProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", className)}>
      {/* 4 Overlapping circular photos */}
      <div className="flex -space-x-2 sm:-space-x-2.5 items-center justify-center">
        {AVATAR_URLS.map((url, idx) => (
          <div
            key={idx}
            className="relative w-11 h-11 sm:w-12 sm:h-12 rounded-full overflow-hidden border-2 border-white shadow-md transition-transform hover:scale-105 flex-shrink-0"
          >
            <Image
              src={url}
              alt={`Active member ${idx + 1}`}
              fill
              className="object-cover"
              sizes="48px"
            />
          </div>
        ))}
      </div>

      {/* 5 Amber Stars */}
      <div className="flex items-center justify-center gap-1 text-[#F59E0B] mt-3.5 sm:mt-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Star key={i} className="w-4 h-4 sm:w-4.5 sm:h-4.5 fill-[#F59E0B] text-[#F59E0B]" />
        ))}
      </div>

      {/* Social proof line - single line on mobile */}
      <p className={cn("text-[13px] sm:text-sm md:text-base font-normal mt-3 leading-snug tracking-tight text-white whitespace-nowrap", textColor)}>
        <span className="font-bold text-white">{peopleCount}</span> people finding{" "}
        <span className="font-bold text-white">{jobsCount}</span> hidden jobs
      </p>
    </div>
  );
}
