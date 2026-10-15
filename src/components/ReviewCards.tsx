import React from "react";
import { Star } from "lucide-react";
import { Review, MiniReview } from "@/data/testimonials";
import { cn } from "@/lib/utils";

const FALLBACK_AVATARS = [
  "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1580489944761-15a19d654956?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=96&h=96&q=75",
];

interface ReviewCardProps {
  review: Review;
  className?: string;
}

/**
 * Centered white testimonial card matching the reference layout:
 * - Crisp white card (bg-white) with subtle gray border
 * - Top centered circular profile photo
 * - Centered candidate name
 * - Centered role / designation in muted text
 * - 5 coral-red stars (#FF4938)
 * - Centered testimonial quote text in readable dark gray
 */
export function ReviewCard({ review, className }: ReviewCardProps) {
  const avatarUrl =
    review.avatar ||
    FALLBACK_AVATARS[
      Math.abs(
        review.name.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0)
      ) % FALLBACK_AVATARS.length
    ];

  return (
    <div
      className={cn(
        "bg-white border border-gray-200/90 rounded-2xl p-7 sm:p-8 flex flex-col items-center text-center shadow-sm hover:shadow-xl hover:border-gray-300 transition-all duration-200 hover:-translate-y-0.5",
        className
      )}
    >
      {/* 1. Centered circular photo */}
      <div className="w-20 h-20 rounded-full overflow-hidden mb-4 ring-4 ring-slate-100 shadow-sm flex-shrink-0 bg-gray-100">
        <img
          src={avatarUrl}
          alt={review.name}
          width={80}
          height={80}
          className="w-full h-full object-cover"
        />
      </div>

      {/* 2. Candidate Name */}
      <h3 className="text-base sm:text-lg font-bold text-[#09090B] tracking-tight leading-snug">
        {review.name}
      </h3>

      {/* 3. Role / Designation */}
      <p className="text-xs sm:text-sm text-gray-500 font-normal mt-0.5 mb-3">
        {review.role || review.handle || "Verified Job Seeker"}
      </p>

      {/* 4. 5 Coral-red / Orange-red stars */}
      <div
        role="img"
        className="flex items-center justify-center gap-1 mb-4 text-[#FF4938]"
        aria-label={`${review.stars} out of 5 stars`}
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <Star key={i} aria-hidden="true" className="w-4 h-4 fill-[#FF4938] text-[#FF4938]" />
        ))}
      </div>

      {/* 5. Centered quote text */}
      <p className="text-sm sm:text-base text-gray-700 leading-relaxed font-normal">
        &ldquo;{review.quote}&rdquo;
      </p>
    </div>
  );
}

interface MiniReviewCardProps {
  review: MiniReview;
  className?: string;
}

/**
 * Mini Review Card for Wall of Love matching the white centered design
 */
export function MiniReviewCard({ review, className }: MiniReviewCardProps) {
  const avatarUrl =
    FALLBACK_AVATARS[
      Math.abs(
        review.name.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0)
      ) % FALLBACK_AVATARS.length
    ];

  return (
    <div
      className={cn(
        "bg-white border border-gray-200/90 rounded-2xl p-6 break-inside-avoid mb-4 flex flex-col items-center text-center shadow-sm hover:shadow-md hover:border-gray-300 transition-all duration-150",
        className
      )}
    >
      {/* 1. Centered circular photo */}
      <div className="w-14 h-14 rounded-full overflow-hidden mb-3 ring-2 ring-slate-100 shadow-sm flex-shrink-0 bg-gray-100">
        <img
          src={avatarUrl}
          alt={review.name}
          width={56}
          height={56}
          className="w-full h-full object-cover"
        />
      </div>

      {/* 2. Name */}
      <h3 className="text-sm sm:text-base font-bold text-[#09090B] leading-tight">
        {review.name}
      </h3>

      {/* 3. Handle / Role */}
      <span className="text-xs text-gray-500 font-normal mt-0.5 mb-2.5">
        {review.handle}
      </span>

      {/* 4. 5 Coral-red stars */}
      <div
        role="img"
        className="flex items-center justify-center gap-1 mb-3 text-[#FF4938]"
        aria-label={`${review.stars} out of 5 stars`}
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <Star key={i} aria-hidden="true" className="w-3.5 h-3.5 fill-[#FF4938] text-[#FF4938]" />
        ))}
      </div>

      {/* 5. Quote */}
      <p className="text-xs sm:text-sm text-gray-700 leading-relaxed font-normal">
        &ldquo;{review.quote}&rdquo;
      </p>
    </div>
  );
}
