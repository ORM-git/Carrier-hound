"use client";

import React, { useEffect, useRef } from "react";
import { useAnimate } from "motion/react";

export type Testimonial = {
  text: string;
  name: string;
  role?: string;
  handle?: string;
  initials?: string;
  avatarBg?: string;
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
                  {/* 1. Initials Avatar Circle on Coloured Background */}
                  <div
                    className={`w-14 h-14 rounded-full flex items-center justify-center font-bold text-white text-base shadow-sm ring-2 ring-slate-100 flex-shrink-0 mb-3 select-none ${item.avatarBg || "bg-blue-600"}`}
                    aria-hidden="true"
                  >
                    <span>{item.initials}</span>
                  </div>

                  {/* 2. Short Title */}
                  <h3 className="text-sm sm:text-base font-bold text-[#09090B] leading-tight">
                    {item.name}
                  </h3>

                  {/* 3. Tiny "Example" Tag */}
                  <span className="text-[11px] font-semibold text-gray-500 bg-gray-100 border border-gray-200/80 px-2.5 py-0.5 rounded-full mt-1.5 mb-2.5">
                    {item.handle || item.role || "Example"}
                  </span>

                  {/* 4. Quote text on real product capability */}
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
