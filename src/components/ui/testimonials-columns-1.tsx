"use client";

import React, { useEffect, useRef } from "react";
import { useAnimate } from "motion/react";
import {
  ExternalLink,
  Layers,
  Sparkles,
  FileText,
  Globe,
  BookmarkCheck,
  Link2,
  Briefcase,
  CheckCircle2,
  Compass,
  Kanban,
  FileEdit,
  type LucideIcon,
} from "lucide-react";

const ICON_MAP: Record<string, LucideIcon> = {
  ExternalLink,
  Layers,
  Sparkles,
  FileText,
  Globe,
  BookmarkCheck,
  Link2,
  Briefcase,
  CheckCircle2,
  Compass,
  Kanban,
  FileEdit,
};

function CardIcon({ name, className }: { name?: string; className?: string }) {
  const Icon = (name && ICON_MAP[name]) || CheckCircle2;
  return <Icon className={className} />;
}

export type Testimonial = {
  text: string;
  name: string;
  role?: string;
  handle?: string;
  iconName?: string;
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
                  {/* 1. Lucide Icon Circle */}
                  <div className="w-12 h-12 rounded-full bg-blue-50 border border-blue-100/80 flex items-center justify-center text-[#2563EB] mb-3.5 shadow-xs flex-shrink-0">
                    <CardIcon name={item.iconName} className="w-5 h-5 text-[#2563EB]" />
                  </div>

                  {/* 2. Card Title */}
                  <h3 className="text-sm sm:text-base font-bold text-[#09090B] leading-tight">
                    {item.name}
                  </h3>

                  {/* 3. Category / Tag */}
                  <span className="text-xs text-blue-600 font-semibold bg-blue-50 border border-blue-100/80 px-2.5 py-0.5 rounded-full mt-1.5 mb-3">
                    {item.handle || item.role}
                  </span>

                  {/* 4. Statement body text */}
                  <p className="text-xs sm:text-[13px] text-gray-700 leading-relaxed font-normal">
                    {item.text}
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
