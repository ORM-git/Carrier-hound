"use client";

import React, { useEffect, useRef } from "react";
import { useAnimate } from "motion/react";
import Image from "next/image";

export type Testimonial = {
  text: string;
  name: string;
  title?: string;
  role?: string;
  handle?: string;
  initials?: string;
  avatarBg?: string;
  avatar?: string;
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
                  className="bg-white border border-slate-200/80 rounded-2xl p-5 sm:p-6 flex flex-col justify-between shadow-xs hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 w-[270px] sm:w-[285px] shrink-0 text-left"
                >
                  <div>
                    {/* Decorative large soft quote-mark icon */}
                    <svg
                      className="w-7 h-7 text-blue-500/25 fill-blue-500/15 mb-3"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M14.017 21v-7.391c0-5.704 3.731-9.57 8.983-10.609l.995 2.151c-2.432.917-3.995 3.638-3.995 5.849h4v10h-9.983zm-14.017 0v-7.391c0-5.704 3.748-9.57 9-10.609l.996 2.151c-2.433.917-3.996 3.638-3.996 5.849h3.983v10h-9.983z" />
                    </svg>

                    {/* Readable, italic-free body text */}
                    <p className="text-[13px] sm:text-sm text-slate-700 leading-relaxed font-normal mb-5">
                      {item.text}
                    </p>
                  </div>

                  {/* Testimonial footer row */}
                  <div className="flex items-center pt-3.5 border-t border-slate-100 gap-2.5 min-w-0">
                    {item.avatar ? (
                      <Image
                        src={item.avatar}
                        alt={item.name}
                        width={36}
                        height={36}
                        className="w-9 h-9 rounded-full object-cover border border-slate-200/80 flex-shrink-0"
                      />
                    ) : (
                      <div
                        className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-white text-xs shadow-2xs flex-shrink-0 select-none ${item.avatarBg || "bg-blue-600"}`}
                        aria-hidden="true"
                      >
                        <span>{item.initials}</span>
                      </div>
                    )}

                    <div className="min-w-0">
                      <h3 className="text-xs sm:text-[13px] font-bold text-[#0F172A] leading-tight truncate">
                        {item.name}
                      </h3>
                      <p className="text-[11px] text-slate-500 font-medium truncate">
                        {item.role || item.title}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </React.Fragment>
          )),
        ]}
      </div>
    </div>
  );
};
