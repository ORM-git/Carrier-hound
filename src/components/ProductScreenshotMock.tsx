"use client";

import React, { useState } from "react";
import { CircleDollarSign, Wrench, Clock } from "lucide-react";

export default function ProductScreenshotMock() {
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);

  return (
    <div className="w-full bg-[#EDF0F4] rounded-t-[24px] sm:rounded-t-[36px] md:rounded-t-[40px] rounded-b-none border-t border-x border-gray-300/70 p-2 sm:p-5 md:p-8 shadow-[0_20px_50px_rgba(15,23,42,0.12)] overflow-hidden text-left">
      <div className="flex flex-row items-start gap-2 sm:gap-4 md:gap-5">
        {/* Left Side: Minimalist Filters Card */}
        <div className="w-[105px] xs:w-[110px] sm:w-[155px] md:w-[175px] shrink-0 bg-white border border-[#E5E7EB] rounded-xl sm:rounded-2xl p-2 sm:p-4 shadow-[0_2px_8px_rgba(0,0,0,0.04)]">
          <h2 className="text-xs sm:text-sm md:text-[15px] font-bold text-[#09090B] tracking-tight mb-2 sm:mb-3">
            Filters
          </h2>

          <div className="grid grid-cols-1 gap-1.5 sm:gap-2.5">
            {/* Filter 1: Role */}
            <div>
              <label className="block text-[10px] sm:text-[11px] font-semibold text-gray-700 mb-0.5 sm:mb-1">
                Role
              </label>
              <div className="w-full h-6 sm:h-7.5 px-1.5 sm:px-3 rounded-md sm:rounded-lg border border-gray-200 bg-white flex items-center text-[10px] sm:text-xs text-gray-400 select-none">
                Select...
              </div>
            </div>

            {/* Filter 2: Location */}
            <div>
              <label className="block text-[10px] sm:text-[11px] font-semibold text-gray-700 mb-0.5 sm:mb-1">
                Location
              </label>
              <div className="w-full h-6 sm:h-7.5 px-1.5 sm:px-3 rounded-md sm:rounded-lg border border-gray-200 bg-white flex items-center text-[10px] sm:text-xs text-gray-400 select-none">
                Select...
              </div>
            </div>

            {/* Filter 3: Tools */}
            <div>
              <label className="block text-[10px] sm:text-[11px] font-semibold text-gray-700 mb-0.5 sm:mb-1">
                Tools
              </label>
              <div className="w-full h-6 sm:h-7.5 px-1.5 sm:px-3 rounded-md sm:rounded-lg border border-gray-200 bg-white flex items-center text-[10px] sm:text-xs text-gray-400 select-none">
                Select...
              </div>
            </div>

            {/* Filter 4: Remote */}
            <div>
              <label className="block text-[10px] sm:text-[11px] font-semibold text-gray-700 mb-0.5 sm:mb-1">
                Remote
              </label>
              <div className="w-full h-6 sm:h-7.5 px-1.5 sm:px-3 rounded-md sm:rounded-lg border border-gray-200 bg-white flex items-center text-[10px] sm:text-xs text-gray-400 select-none">
                Select...
              </div>
            </div>
          </div>
        </div>

        {/* Right Side: 3-Layer Staggered Overlapping Cards */}
        <div className="relative flex-1 min-w-0 pb-2 sm:pb-6">
          {/* Card 3 (Back Layer - Top Right) */}
          <div
            className="absolute z-0 top-0 bottom-[70px] left-[16px] sm:left-[32px] md:left-[48px] right-0 bg-white border border-[#E5E7EB] rounded-xl sm:rounded-2xl p-2 sm:p-3.5 md:p-4 shadow-[0_2px_6px_rgba(0,0,0,0.03)] pointer-events-none select-none overflow-hidden"
            aria-hidden="true"
          >
            <div className="space-y-0.5">
              <h4 className="font-bold text-[#09090B] text-[11px] sm:text-sm md:text-base tracking-tight truncate leading-tight">
                Sales Development Representative
              </h4>
              <p className="text-[9px] sm:text-xs text-gray-500 font-normal leading-tight">
                Cribl
              </p>
            </div>
          </div>

          {/* Card 2 (Middle Layer) */}
          <div
            className="absolute z-10 top-[34px] bottom-[34px] left-[8px] sm:left-[16px] md:left-[24px] right-[8px] sm:right-[16px] md:right-[24px] bg-white border border-[#E5E7EB] rounded-xl sm:rounded-2xl p-2 sm:p-3.5 md:p-4 shadow-[0_3px_10px_rgba(0,0,0,0.04)] pointer-events-none select-none overflow-hidden"
            aria-hidden="true"
          >
            <div className="space-y-0.5">
              <h4 className="font-bold text-[#09090B] text-[11px] sm:text-sm md:text-base tracking-tight truncate leading-tight">
                Senior Product Designer
              </h4>
              <p className="text-[9px] sm:text-xs text-gray-500 font-normal leading-tight">
                Interface AI
              </p>
            </div>
          </div>

          {/* Card 1 (Front Layer - Main Focus) */}
          <div className="relative z-20 mt-[68px] mr-[16px] sm:mr-[32px] md:mr-[48px] bg-white border border-[#E5E7EB] rounded-xl sm:rounded-2xl p-2.5 sm:p-4 md:p-5 shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
            <div className="space-y-1.5 sm:space-y-2">
              {/* Job Title & Company */}
              <div>
                <h4 className="font-bold text-[#09090B] text-xs sm:text-base md:text-lg tracking-tight truncate leading-tight">
                  Software Engineer
                </h4>
                <p className="text-[10px] sm:text-xs text-gray-500 font-normal mt-0.5">
                  Tenable, Inc.
                </p>
              </div>

              {/* Salary Badge / Text with Amber Coin Icon */}
              <div className="flex items-center gap-1 sm:gap-1.5 text-[10px] sm:text-[13px] font-semibold text-[#D97706]">
                <CircleDollarSign className="w-3.5 h-3.5 text-[#D97706] shrink-0" />
                <span className="truncate">$106,000 - $141,333</span>
              </div>

              {/* Tools / Tech Stack with Wrench Icon */}
              <div className="flex items-start gap-1 sm:gap-1.5 text-[9px] sm:text-xs text-gray-600 leading-tight sm:leading-relaxed">
                <Wrench className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
                <span className="line-clamp-2 sm:line-clamp-none">
                  Agile, API, Docker, Go, Java, Kotlin, Kubernetes, Linux, MySQL, PHP, PostgreSQL, SDLC, SQL
                </span>
              </div>

              {/* Verified Date with Clock Icon */}
              <div className="flex items-center gap-1 sm:gap-1.5 text-[9px] sm:text-xs text-gray-400">
                <Clock className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                <span>November 14, 2024</span>
              </div>

              {/* Action Buttons Row */}
              <div className="flex items-center gap-1 sm:gap-1.5 pt-1 sm:pt-2 overflow-x-auto no-scrollbar flex-nowrap">
                <a
                  href="/job-search/all"
                  className="shrink-0 whitespace-nowrap bg-[#18181B] hover:bg-black text-white text-[9px] sm:text-xs font-semibold px-2 sm:px-3.5 py-1 sm:py-1.5 rounded-md sm:rounded-lg transition-colors shadow-sm inline-flex items-center"
                >
                  Apply Now
                </a>
                <a
                  href="/job-search/all"
                  className="shrink-0 whitespace-nowrap bg-[#18181B] hover:bg-black text-white text-[9px] sm:text-xs font-semibold px-1.5 sm:px-2.5 py-1 sm:py-1.5 rounded-md sm:rounded-lg transition-colors shadow-sm inline-flex items-center"
                >
                  + 6 more
                </a>
                <button
                  type="button"
                  onClick={() => {
                    setLiked(!liked);
                    if (disliked) setDisliked(false);
                  }}
                  className={`shrink-0 whitespace-nowrap border text-[9px] sm:text-xs font-medium px-2 sm:px-3 py-1 sm:py-1.5 rounded-md sm:rounded-lg transition-colors ${
                    liked
                      ? "bg-blue-50 border-blue-400 text-blue-700"
                      : "bg-white hover:bg-gray-50 border-gray-300 text-gray-800"
                  }`}
                >
                  Like
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDisliked(!disliked);
                    if (liked) setLiked(false);
                  }}
                  className={`shrink-0 whitespace-nowrap border text-[9px] sm:text-xs font-medium px-2 sm:px-3 py-1 sm:py-1.5 rounded-md sm:rounded-lg transition-colors ${
                    disliked
                      ? "bg-red-50 border-red-400 text-red-700"
                      : "bg-white hover:bg-gray-50 border-gray-300 text-gray-800"
                  }`}
                >
                  Dislike
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
