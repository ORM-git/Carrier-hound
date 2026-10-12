"use client";

import React, { useEffect, useRef } from "react";
import { useAnimate } from "motion/react";
import { Star } from "lucide-react";

export type Testimonial = {
  text: string;
  image: string;
  name: string;
  role?: string;
  handle?: string;
  stars?: number;
};

export const TestimonialsColumn = (props: {
  className?: string;
  testimonials: Testimonial[];
  duration?: number;
}) => {
  const [scope, animate] = useAnimate();
  const controlsRef = useRef<any>(null);

  useEffect(() => {
    const controls = animate(
      scope.current,
      { translateY: ["0%", "-50%"] },
      {
        duration: props.duration || 20,
        repeat: Infinity,
        ease: "linear",
        repeatType: "loop",
      }
    );
    controlsRef.current = controls;

    return () => {
      controls.stop();
    };
  }, [animate, props.duration]);

  return (
    <div
      className={props.className}
      onMouseEnter={() => {
        controlsRef.current?.pause();
      }}
      onMouseLeave={() => {
        controlsRef.current?.play();
      }}
    >
      <div
        ref={scope}
        className="flex flex-col gap-4 pb-4"
      >
        {[
          ...new Array(2).fill(0).map((_, index) => (
            <React.Fragment key={index}>
              {props.testimonials.map((item, i) => (
                <div
                  key={`${index}-${i}`}
                  className="bg-white border border-gray-200/90 rounded-2xl p-6 flex flex-col items-center text-center shadow-sm hover:shadow-md hover:border-gray-300 transition-all duration-150 w-[270px] sm:w-[280px] shrink-0"
                >
                  {/* 1. Centered circular photo */}
                  <div className="w-14 h-14 rounded-full overflow-hidden mb-3 ring-2 ring-slate-100 shadow-sm flex-shrink-0 bg-gray-100">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.image}
                      alt={item.name}
                      width={56}
                      height={56}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover"
                    />
                  </div>

                  {/* 2. Name */}
                  <h5 className="text-sm sm:text-base font-bold text-[#09090B] leading-tight">
                    {item.name}
                  </h5>

                  {/* 3. Handle / Role */}
                  <span className="text-xs text-gray-500 font-normal mt-0.5 mb-2.5">
                    {item.handle || item.role}
                  </span>

                  {/* 4. 5 Coral-red stars */}
                  <div
                    className="flex items-center justify-center gap-1 mb-3 text-[#FF4938]"
                    aria-label={`${item.stars || 5} out of 5 stars`}
                  >
                    {Array.from({ length: item.stars || 5 }).map((_, starIdx) => (
                      <Star
                        key={starIdx}
                        className="w-3.5 h-3.5 fill-[#FF4938] text-[#FF4938]"
                      />
                    ))}
                  </div>

                  {/* 5. Centered quote text */}
                  <p className="text-xs sm:text-[13px] text-gray-700 leading-relaxed font-normal">
                    &ldquo;{item.text}&rdquo;
                  </p>
                </div>
              ))}
            </React.Fragment>
          )),
        ]}
      </div>
    </div>
  );
};
