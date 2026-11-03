import React from "react";
import Image from "next/image";

export default function LandingComparisonSection() {
  return (
    <div className="w-full max-w-[560px] mx-auto px-4">
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
