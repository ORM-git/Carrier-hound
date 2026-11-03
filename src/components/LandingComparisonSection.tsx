import React from "react";
import Image from "next/image";

export default function LandingComparisonSection() {
  return (
    <div className="w-full max-w-[560px] mx-auto px-4">
      <div className="text-center mb-6 sm:mb-8">
        <h2 className="text-2xl sm:text-4xl md:text-[42px] font-extrabold text-[#09090B] tracking-tight leading-[1.15] max-w-md mx-auto">
          Tired of getting
          <span className="block">auto-rejected?</span>
        </h2>
      </div>
      <Image
        src="/careermonke-comparison-boxes.gif"
        width={728}
        height={900}
        alt="The usual grind vs the Monke way: five comparisons"
        loading="lazy"
        decoding="async"
        unoptimized
        className="w-full h-auto block"
      />
    </div>
  );
}
