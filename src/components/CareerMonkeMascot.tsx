"use client";

import React, { useState, useEffect } from "react";
import clsx from "clsx";

export type MascotMood = "sad" | "neutral" | "happy" | "surprised";

export interface CareerMonkeMascotProps {
  mood?: MascotMood;
  size?: number | string;
  loop?: boolean;
  className?: string;
  animateOnScroll?: boolean;
  isInView?: boolean;
  shouldReduceMotion?: boolean | null;
}

/**
 * CareerMonke mascot: code-driven animated SVG React component.
 * Features separate SVG groups:
 *  - body/hoodie (grey for sad, brand blue #2563EB for happy/neutral)
 *  - arms (chin-propping & phone for sad; swinging vine & pointing for happy)
 *  - head (tan face contour, round cheeks, blush)
 *  - ears (round monkey ears with inner ear detail)
 *  - hair (spiky white hair with idle wobble)
 *  - eyebrows (visible above sunglasses, animated per mood)
 *  - sunglasses (dark Wayfarer shades with lens shine and periodic eyelid blink)
 *  - mouth (droopy frown with drool for sad; wide joyful grin for happy)
 */
export default function CareerMonkeMascot({
  mood = "neutral",
  size = 115,
  loop = true,
  className,
  animateOnScroll = false,
  isInView = true,
  shouldReduceMotion = false,
}: CareerMonkeMascotProps) {
  // Handle neutral-to-happy transition on scroll-in
  const [currentMood, setCurrentMood] = useState<MascotMood>(
    animateOnScroll ? "neutral" : mood
  );
  const [hasScrolledIn, setHasScrolledIn] = useState(false);

  useEffect(() => {
    if (animateOnScroll && isInView && !hasScrolledIn) {
      setHasScrolledIn(true);
      const timer = setTimeout(() => {
        setCurrentMood(mood);
      }, 250);
      return () => clearTimeout(timer);
    } else if (!animateOnScroll) {
      setCurrentMood(mood);
    }
  }, [animateOnScroll, isInView, hasScrolledIn, mood]);

  const isAnimated = loop && !shouldReduceMotion;
  const playState = isInView && isAnimated ? "running" : "paused";

  // Palette tokens
  const isSad = currentMood === "sad";
  const isHappy = currentMood === "happy";
  const isSurprised = currentMood === "surprised";

  // Colors
  const hoodieFill = isSad ? "#4B5563" : "#2563EB";
  const hoodieShadow = isSad ? "#374151" : "#1D4ED8";
  const skinTan = "#FED7AA";
  const outlineDark = "#18181B";

  return (
    <div
      className={clsx(
        "relative flex items-center justify-center select-none overflow-visible",
        className
      )}
      style={{
        width: typeof size === "number" ? `${size}px` : size,
        height: typeof size === "number" ? `${size}px` : size,
      }}
      aria-label={`CareerMonke mascot (${currentMood})`}
      role="img"
    >
      {/* Self-contained CSS Keyframes for GPU-accelerated transforms */}
      <style>{`
        /* Idle hair wobble */
        @keyframes cm-hair-wobble {
          0%, 100% { transform: rotate(-1.5deg); }
          50% { transform: rotate(1.5deg); }
        }
        /* Periodic eyelid blink over glasses */
        @keyframes cm-blink {
          0%, 93%, 97%, 100% { opacity: 0; transform: scaleY(0); }
          94%, 96% { opacity: 1; transform: scaleY(1); }
        }
        /* Sad: slow breathing */
        @keyframes cm-sad-breathe {
          0%, 100% { transform: scale(1) translateY(0); }
          50% { transform: scale(1.02) translateY(2px); }
        }
        /* Sad: head-nod tilt */
        @keyframes cm-sad-head-tilt {
          0%, 100% { transform: rotate(-2.5deg); }
          50% { transform: rotate(2deg); }
        }
        /* Sad: floating Z z z */
        @keyframes cm-float-z1 {
          0% { opacity: 0; transform: translate(0, 3px) scale(0.85); }
          40% { opacity: 0.9; }
          100% { opacity: 0; transform: translate(3px, -10px) scale(1.05); }
        }
        @keyframes cm-float-z2 {
          0% { opacity: 0; transform: translate(0, 3px) scale(0.85); }
          40% { opacity: 0.9; }
          100% { opacity: 0; transform: translate(5px, -14px) scale(1.15); }
        }
        @keyframes cm-float-z3 {
          0% { opacity: 0; transform: translate(0, 3px) scale(0.85); }
          40% { opacity: 0.9; }
          100% { opacity: 0; transform: translate(7px, -18px) scale(1.25); }
        }
        /* Sad: circular refresh arrows wobble */
        @keyframes cm-arrows-wobble {
          0%, 100% { transform: rotate(-8deg); }
          50% { transform: rotate(8deg); }
        }
        /* Happy: quick head bob */
        @keyframes cm-happy-head-bob {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          35% { transform: translateY(-4px) rotate(-1.5deg); }
          70% { transform: translateY(1px) rotate(1.5deg); }
        }
        /* Happy: glasses bounce */
        @keyframes cm-glasses-bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3.5px); }
        }
        /* Happy: sparkles pulse */
        @keyframes cm-sparkle-pulse {
          0%, 100% { opacity: 0.25; transform: scale(0.7) rotate(0deg); }
          50% { opacity: 1; transform: scale(1.2) rotate(15deg); }
        }
        /* Scroll-in transition: spring bounce */
        @keyframes cm-spring-bounce {
          0% { transform: scale(0.88); }
          45% { transform: scale(1.08); }
          70% { transform: scale(0.96); }
          85% { transform: scale(1.02); }
          100% { transform: scale(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          .cm-anim-hair,
          .cm-anim-blink,
          .cm-anim-sad-breathe,
          .cm-anim-sad-tilt,
          .cm-anim-float-z1,
          .cm-anim-float-z2,
          .cm-anim-float-z3,
          .cm-anim-arrows,
          .cm-anim-happy-bob,
          .cm-anim-glasses-bounce,
          .cm-anim-sparkle,
          .cm-anim-spring-bounce {
            animation: none !important;
            transform: none !important;
          }
        }
      `}</style>

      <svg
        viewBox="0 0 200 200"
        className={clsx(
          "w-full h-full max-h-full overflow-visible",
          hasScrolledIn && "cm-anim-spring-bounce"
        )}
        style={{
          animation: hasScrolledIn ? "cm-spring-bounce 0.65s cubic-bezier(0.34, 1.56, 0.64, 1)" : undefined,
          willChange: "transform",
        }}
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* ATMOSPHERIC BACKGROUND EFFECTS (Sad: Refresh Arrows; Happy: Sparkles) */}
        {isSad && (
          <g
            id="effects-sad-arrows"
            className="cm-anim-arrows"
            style={{
              transformOrigin: "100px 30px",
              animation: "cm-arrows-wobble 3s ease-in-out infinite",
              animationPlayState: playState,
              willChange: "transform",
            }}
          >
            {/* Top blue circular refresh arrows */}
            <path
              d="M 86 26 C 90 20 102 18 114 24"
              fill="none"
              stroke="#2563EB"
              strokeWidth="3.5"
              strokeLinecap="round"
            />
            <path d="M 112 18 L 118 24 L 110 28 Z" fill="#2563EB" />
            <path
              d="M 114 34 C 110 40 98 42 86 36"
              fill="none"
              stroke="#2563EB"
              strokeWidth="3.5"
              strokeLinecap="round"
            />
            <path d="M 88 42 L 82 36 L 90 32 Z" fill="#2563EB" />
          </g>
        )}

        {isHappy && (
          <g id="effects-happy">
            {/* Blue sparkle 1 */}
            <path
              d="M 150 36 Q 151 40 155 41 Q 151 42 150 46 Q 149 42 145 41 Q 149 40 150 36 Z"
              fill="#2563EB"
              className="cm-anim-sparkle"
              style={{
                transformOrigin: "150px 41px",
                animation: "cm-sparkle-pulse 2s ease-in-out infinite",
                animationPlayState: playState,
              }}
            />
            {/* Gold sparkle 2 */}
            <path
              d="M 136 22 Q 137 25 140 26 Q 137 27 136 30 Q 135 27 132 26 Q 135 25 136 22 Z"
              fill="#FACC15"
              className="cm-anim-sparkle"
              style={{
                transformOrigin: "136px 26px",
                animation: "cm-sparkle-pulse 2.2s ease-in-out 0.4s infinite",
                animationPlayState: playState,
              }}
            />
            {/* Blue sparkle 3 */}
            <path
              d="M 170 58 Q 171 61 174 62 Q 171 63 170 66 Q 169 63 166 62 Q 169 61 170 58 Z"
              fill="#3B82F6"
              className="cm-anim-sparkle"
              style={{
                transformOrigin: "170px 62px",
                animation: "cm-sparkle-pulse 1.8s ease-in-out 0.8s infinite",
                animationPlayState: playState,
              }}
            />
          </g>
        )}

        {/* MASTER MASCOT BODY WRAPPER (Breathing/Tilt for Sad; Bob for Happy) */}
        <g
          className={clsx(
            isSad && "cm-anim-sad-breathe",
            isHappy && "cm-anim-happy-head-bob"
          )}
          style={{
            transformOrigin: "100px 150px",
            animation: isSad
              ? "cm-sad-breathe 3s ease-in-out infinite"
              : isHappy
              ? "cm-happy-head-bob 1.8s ease-in-out infinite"
              : undefined,
            animationPlayState: playState,
            willChange: "transform",
          }}
        >
          {/* GROUP 1: BODY / HOODIE */}
          <g id="body-hoodie">
            {/* Torso & Shoulders */}
            <path
              d="M 38 160 C 38 143 58 138 78 138 L 122 138 C 142 138 162 143 162 160 L 168 200 L 32 200 Z"
              fill={hoodieFill}
              stroke={outlineDark}
              strokeWidth="4"
              strokeLinejoin="round"
            />
            {/* Hoodie bottom shading */}
            <path
              d="M 35 190 C 70 196 130 196 165 190 L 168 200 L 32 200 Z"
              fill={hoodieShadow}
            />
            {/* Tan neck triangular notch */}
            <polygon points="88,138 112,138 100,154" fill={skinTan} stroke={outlineDark} strokeWidth="3" />
            {/* Collar rim fold */}
            <path
              d="M 76 138 C 84 154 116 154 124 138"
              fill="none"
              stroke={outlineDark}
              strokeWidth="4"
              strokeLinecap="round"
            />
            {/* White Hoodie Drawstrings */}
            <path
              d="M 87 148 L 85 180"
              stroke="#FFFFFF"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <rect x="83.5" y="177" width="3" height="5" rx="1.5" fill="#E5E7EB" stroke={outlineDark} strokeWidth="1" />
            <path
              d="M 113 148 L 115 180"
              stroke="#FFFFFF"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <rect x="113.5" y="177" width="3" height="5" rx="1.5" fill="#E5E7EB" stroke={outlineDark} strokeWidth="1" />
          </g>

          {/* GROUP 2: ARMS */}
          <g id="arms">
            {isSad ? (
              <>
                {/* Desk horizontal line */}
                <line x1="15" y1="198" x2="185" y2="198" stroke={outlineDark} strokeWidth="4" strokeLinecap="round" />
                {/* Left hand holding phone in foreground */}
                <g id="arm-phone">
                  <path
                    d="M 40 180 C 50 166 76 168 96 178 L 102 198 L 35 198 Z"
                    fill={hoodieFill}
                    stroke={outlineDark}
                    strokeWidth="3.5"
                  />
                  {/* Smartphone body */}
                  <rect
                    x="118"
                    y="148"
                    width="26"
                    height="46"
                    rx="4"
                    fill="#1E293B"
                    stroke={outlineDark}
                    strokeWidth="3"
                    transform="rotate(-6 131 171)"
                  />
                  {/* Smartphone screen glow */}
                  <rect
                    x="121"
                    y="152"
                    width="20"
                    height="38"
                    rx="2"
                    fill="#38BDF8"
                    opacity="0.85"
                    transform="rotate(-6 131 171)"
                  />
                  {/* Tan fingers gripping phone */}
                  <path
                    d="M 114 165 C 120 165 125 167 125 171 C 125 175 119 176 112 176 Z"
                    fill={skinTan}
                    stroke={outlineDark}
                    strokeWidth="2.5"
                  />
                  <path
                    d="M 113 174 C 119 174 124 176 124 180 C 124 184 118 185 111 185 Z"
                    fill={skinTan}
                    stroke={outlineDark}
                    strokeWidth="2.5"
                  />
                  <path
                    d="M 111 183 C 117 183 122 185 122 189 C 122 193 116 194 109 194 Z"
                    fill={skinTan}
                    stroke={outlineDark}
                    strokeWidth="2.5"
                  />
                </g>
                {/* Right arm propping up chin */}
                <g id="arm-propping">
                  <path
                    d="M 130 198 C 142 185 146 160 142 142 L 152 144 C 158 165 155 188 144 198 Z"
                    fill={hoodieFill}
                    stroke={outlineDark}
                    strokeWidth="3.5"
                  />
                  {/* Hand under cheek */}
                  <ellipse cx="140" cy="138" rx="8" ry="10" fill={skinTan} stroke={outlineDark} strokeWidth="3" />
                </g>
              </>
            ) : isHappy ? (
              <>
                {/* Left arm raised holding vine */}
                <g id="arm-vine">
                  {/* Vine curving from top-left */}
                  <path
                    d="M 0 30 C 25 50 48 45 66 32"
                    fill="none"
                    stroke="#15803D"
                    strokeWidth="5"
                    strokeLinecap="round"
                  />
                  {/* Vine leaves */}
                  <path d="M 12 36 C 8 48 20 52 24 40 C 24 38 18 36 12 36 Z" fill="#22C55E" stroke="#15803D" strokeWidth="2" />
                  <path d="M 44 45 C 48 56 60 54 58 42 C 54 42 48 44 44 45 Z" fill="#22C55E" stroke="#15803D" strokeWidth="2" />
                  {/* Left hand holding vine */}
                  <circle cx="56" cy="40" r="9" fill={skinTan} stroke={outlineDark} strokeWidth="3" />
                  <path
                    d="M 44 140 C 35 110 42 65 54 44 L 62 48 C 52 70 45 112 56 140 Z"
                    fill={hoodieFill}
                    stroke={outlineDark}
                    strokeWidth="3.5"
                  />
                </g>
                {/* Right arm pointing eagerly forward */}
                <g id="arm-pointing">
                  <path
                    d="M 138 145 C 154 136 170 134 184 130"
                    fill="none"
                    stroke={hoodieFill}
                    strokeWidth="14"
                    strokeLinecap="round"
                  />
                  <path
                    d="M 138 145 C 154 136 170 134 184 130"
                    fill="none"
                    stroke={outlineDark}
                    strokeWidth="3.5"
                    strokeLinecap="round"
                  />
                  {/* Pointing hand with extended finger */}
                  <circle cx="184" cy="130" r="6" fill={skinTan} stroke={outlineDark} strokeWidth="2.5" />
                  <path d="M 184 128 L 195 125 C 197 124 198 127 197 129 L 186 133 Z" fill={skinTan} stroke={outlineDark} strokeWidth="2" />
                </g>
              </>
            ) : (
              // Neutral / Surprised resting arms
              <g id="arm-neutral">
                <path
                  d="M 42 165 C 55 178 80 182 95 182"
                  fill="none"
                  stroke={hoodieFill}
                  strokeWidth="12"
                  strokeLinecap="round"
                />
                <circle cx="95" cy="182" r="6" fill={skinTan} stroke={outlineDark} strokeWidth="2.5" />
                <path
                  d="M 158 165 C 145 178 120 182 105 182"
                  fill="none"
                  stroke={hoodieFill}
                  strokeWidth="12"
                  strokeLinecap="round"
                />
                <circle cx="105" cy="182" r="6" fill={skinTan} stroke={outlineDark} strokeWidth="2.5" />
              </g>
            )}
          </g>

          {/* HEAD WRAPPER (Tilt animation for Sad) */}
          <g
            className={clsx(isSad && "cm-anim-sad-tilt")}
            style={{
              transformOrigin: "100px 140px",
              animation: isSad ? "cm-sad-head-tilt 4s ease-in-out infinite" : undefined,
              animationPlayState: playState,
              willChange: "transform",
            }}
          >
            {/* GROUP 3: EARS */}
            <g id="ears">
              {/* Left ear */}
              <circle cx="46" cy="102" r="16" fill={skinTan} stroke={outlineDark} strokeWidth="4" />
              <path
                d="M 47 95 C 41 98 41 106 47 109 C 50 110 52 107 50 104"
                fill="none"
                stroke={outlineDark}
                strokeWidth="3"
                strokeLinecap="round"
              />
              {/* Right ear */}
              <circle cx="154" cy="102" r="16" fill={skinTan} stroke={outlineDark} strokeWidth="4" />
              <path
                d="M 153 95 C 159 98 159 106 153 109 C 150 110 148 107 150 104"
                fill="none"
                stroke={outlineDark}
                strokeWidth="3"
                strokeLinecap="round"
              />
            </g>

            {/* GROUP 4: HEAD BASE CONTOUR */}
            <g id="head">
              <path
                d="M 66 90 C 66 72 80 64 100 64 C 120 64 134 72 134 90 C 134 100 144 110 144 124 C 144 142 124 150 100 150 C 76 150 56 142 56 124 C 56 110 66 100 66 90 Z"
                fill={skinTan}
                stroke={outlineDark}
                strokeWidth="4"
                strokeLinejoin="round"
              />
              {/* Soft cheek blush on happy */}
              {isHappy && (
                <>
                  <circle cx="74" cy="120" r="5" fill="#FDBA74" opacity="0.6" />
                  <circle cx="126" cy="120" r="5" fill="#FDBA74" opacity="0.6" />
                </>
              )}
            </g>

            {/* GROUP 5: HAIR WITH IDLE WOBBLE */}
            <g
              id="hair"
              className="cm-anim-hair"
              style={{
                transformOrigin: "100px 80px",
                animation: "cm-hair-wobble 3.2s ease-in-out infinite",
                animationPlayState: playState,
                willChange: "transform",
              }}
            >
              {/* Spiky white hair crest & side tufts */}
              <path
                d="M 64 92 C 50 82 48 68 58 56 C 54 48 64 38 74 42 C 78 30 92 18 104 18 C 114 18 122 28 126 34 C 134 26 146 32 148 42 C 158 46 162 58 154 70 C 160 80 154 94 138 96 C 136 82 124 70 100 70 C 76 70 66 82 64 92 Z"
                fill="#FFFFFF"
                stroke={outlineDark}
                strokeWidth="4"
                strokeLinejoin="round"
              />
              {/* Hair spike detail lines */}
              <path d="M 94 36 L 102 24 L 108 36" stroke={outlineDark} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <path d="M 74 52 L 80 44 L 84 54" stroke={outlineDark} strokeWidth="2.5" strokeLinecap="round" fill="none" />
              <path d="M 126 50 L 132 44 L 136 52" stroke={outlineDark} strokeWidth="2.5" strokeLinecap="round" fill="none" />
            </g>

            {/* GROUP 6: EYEBROWS (VISIBLE ABOVE SUNGLASSES) */}
            <g id="eyebrows">
              {isSad ? (
                <>
                  {/* Droopy sad eyebrows slanting downwards outward */}
                  <path d="M 70 78 Q 80 71 88 74" stroke={outlineDark} strokeWidth="4.5" strokeLinecap="round" fill="none" />
                  <path d="M 112 74 Q 120 71 130 78" stroke={outlineDark} strokeWidth="4.5" strokeLinecap="round" fill="none" />
                </>
              ) : isHappy ? (
                <>
                  {/* High cheerful arched eyebrows */}
                  <path d="M 70 72 Q 80 64 90 71" stroke={outlineDark} strokeWidth="4.5" strokeLinecap="round" fill="none" />
                  <path d="M 110 71 Q 120 64 130 72" stroke={outlineDark} strokeWidth="4.5" strokeLinecap="round" fill="none" />
                </>
              ) : isSurprised ? (
                <>
                  {/* Extra high surprised eyebrows */}
                  <path d="M 70 66 Q 80 58 90 66" stroke={outlineDark} strokeWidth="4.5" strokeLinecap="round" fill="none" />
                  <path d="M 110 66 Q 120 58 130 67" stroke={outlineDark} strokeWidth="4.5" strokeLinecap="round" fill="none" />
                </>
              ) : (
                <>
                  {/* Neutral relaxed eyebrows */}
                  <path d="M 72 74 Q 80 72 88 75" stroke={outlineDark} strokeWidth="4.5" strokeLinecap="round" fill="none" />
                  <path d="M 112 75 Q 120 72 128 74" stroke={outlineDark} strokeWidth="4.5" strokeLinecap="round" fill="none" />
                </>
              )}
            </g>

            {/* GROUP 7: SUNGLASSES (WITH BOUNCE ON HAPPY) */}
            <g
              id="sunglasses"
              className={clsx(isHappy && "cm-anim-glasses-bounce")}
              style={{
                animation: isHappy ? "cm-glasses-bounce 1.8s ease-in-out infinite" : undefined,
                animationPlayState: playState,
                willChange: "transform",
              }}
            >
              {/* Wayfarer black frame */}
              <path
                d="M 60 84 L 140 84 C 145 84 148 88 146 93 L 139 111 C 137 116 128 119 122 116 L 102 106 L 98 106 L 78 116 C 72 119 63 116 61 111 L 54 93 C 52 88 55 84 60 84 Z"
                fill={outlineDark}
                stroke={outlineDark}
                strokeWidth="2"
                strokeLinejoin="round"
              />
              {/* Left dark lens */}
              <path
                d="M 64 88 L 95 88 L 93 104 L 79 112 C 73 113 67 110 65 104 Z"
                fill="#27272A"
              />
              {/* Right dark lens */}
              <path
                d="M 105 88 L 136 88 L 135 104 C 133 110 127 113 121 112 L 107 104 Z"
                fill="#27272A"
              />
              {/* Specular shine stripes on dark lenses */}
              <path d="M 70 90 L 76 90 L 68 108 L 64 108 Z" fill="#FFFFFF" opacity="0.32" />
              <path d="M 112 90 L 118 90 L 110 108 L 106 108 Z" fill="#FFFFFF" opacity="0.32" />

              {/* PERIODIC EYELID BLINK OVER GLASSES */}
              <g
                id="eyelids-blink"
                className="cm-anim-blink"
                style={{
                  transformOrigin: "100px 98px",
                  animation: "cm-blink 4.2s infinite",
                  animationPlayState: playState,
                }}
              >
                <line x1="64" y1="98" x2="95" y2="98" stroke={skinTan} strokeWidth="4" strokeLinecap="round" />
                <line x1="105" y1="98" x2="136" y2="98" stroke={skinTan} strokeWidth="4" strokeLinecap="round" />
              </g>
            </g>

            {/* GROUP 8: MOUTH */}
            <g id="mouth">
              {isSad ? (
                <>
                  {/* Downturned sleepy mouth with gap */}
                  <path
                    d="M 88 126 C 92 133 104 134 110 128 C 104 130 94 130 88 126 Z"
                    fill="#7F1D1D"
                    stroke={outlineDark}
                    strokeWidth="3.5"
                    strokeLinejoin="round"
                  />
                  {/* Drool droplet coming from right corner */}
                  <path
                    d="M 108 132 C 108 136 106 141 108 144 C 110 145 113 145 113 143 C 114 139 111 135 110 132 Z"
                    fill="#93C5FD"
                    stroke="#3B82F6"
                    strokeWidth="1.2"
                  />
                </>
              ) : isHappy ? (
                <>
                  {/* Big broad open ecstatic smile with white upper teeth & tongue */}
                  <path
                    d="M 78 122 C 78 144 122 144 122 122 C 110 125 90 125 78 122 Z"
                    fill="#4C0519"
                    stroke={outlineDark}
                    strokeWidth="4"
                    strokeLinejoin="round"
                  />
                  {/* Upper teeth */}
                  <path
                    d="M 80 123 C 90 125 110 125 120 123 C 118 129 82 129 80 123 Z"
                    fill="#FFFFFF"
                  />
                  {/* Cheerful tongue */}
                  <path
                    d="M 88 138 C 94 132 106 132 112 138 C 105 142 95 142 88 138 Z"
                    fill="#FB7185"
                  />
                </>
              ) : isSurprised ? (
                /* Surprised open "O" mouth */
                <ellipse cx="100" cy="129" rx="8" ry="11" fill="#4C0519" stroke={outlineDark} strokeWidth="3.5" />
              ) : (
                /* Neutral calm confident smirk line */
                <path
                  d="M 88 127 Q 100 133 112 127"
                  stroke={outlineDark}
                  strokeWidth="4"
                  strokeLinecap="round"
                  fill="none"
                />
              )}
            </g>
          </g>
        </g>

        {/* FLOATING "Z Z Z" FOR SAD MOOD */}
        {isSad && (
          <g id="effects-sad-zzz">
            <text
              x="146"
              y="98"
              fill="#4B5563"
              stroke="#18181B"
              strokeWidth="1"
              fontSize="14"
              fontWeight="900"
              className="cm-anim-float-z1"
              style={{
                animation: "cm-float-z1 2.8s ease-in-out infinite",
                animationPlayState: playState,
              }}
            >
              z
            </text>
            <text
              x="154"
              y="82"
              fill="#4B5563"
              stroke="#18181B"
              strokeWidth="1.2"
              fontSize="17"
              fontWeight="900"
              className="cm-anim-float-z2"
              style={{
                animation: "cm-float-z2 2.8s ease-in-out 0.8s infinite",
                animationPlayState: playState,
              }}
            >
              z
            </text>
            <text
              x="164"
              y="64"
              fill="#374151"
              stroke="#18181B"
              strokeWidth="1.4"
              fontSize="21"
              fontWeight="900"
              className="cm-anim-float-z3"
              style={{
                animation: "cm-float-z3 2.8s ease-in-out 1.6s infinite",
                animationPlayState: playState,
              }}
            >
              Z
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
