import React from "react";
import Image from "next/image";

export default function LandingComparisonSection() {
  return (
    <div className="w-full max-w-[560px] mx-auto px-4">
      <h2 className="text-2xl sm:text-3xl font-bold text-[#090E34] text-center mb-4 leading-tight">
        Tired of getting auto rejection
      </h2>
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
