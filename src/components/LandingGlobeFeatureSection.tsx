"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { ArrowRight, Compass, Play, RotateCcw } from "lucide-react";
import * as d3 from "d3";

interface StatsData {
  jobsToday: number | null;
  totalJobs: number | null;
  fetchStatus: "loading" | "success" | "error";
  lastFetchedAt: number | null;
}

interface TourCity {
  id: string;
  name: string;
  coords: [number, number]; // [lon, lat]
  targetRotation: [number, number]; // [-lon, -lat]
  role: string;
  tags: Array<{
    text: string;
    variant: "neutral" | "warning" | "success";
  }>;
}

// Demo origin marker (Bangalore) per prompt: DEMO data, not user's location
const DEMO_HOME_COORDS: [number, number] = [77.5946, 12.9716];

// The 3 canonical tour cities per prompt: Singapore, Paris, San Francisco
const TOUR_CITIES: TourCity[] = [
  {
    id: "sf",
    name: "San Francisco",
    coords: [-122.4194, 37.7749],
    targetRotation: [122.4, -37.7],
    role: "ML Engineer",
    tags: [
      { text: "On-site", variant: "neutral" },
      { text: "✕ Needs US work permit", variant: "warning" },
    ],
  },
  {
    id: "paris",
    name: "Paris",
    coords: [2.3522, 48.8566],
    targetRotation: [-2.35, -48.8],
    role: "Senior DevOps Engineer",
    tags: [
      { text: "Remote", variant: "neutral" },
      { text: "✓ EU Work Permit", variant: "success" },
    ],
  },
  {
    id: "sg",
    name: "Singapore",
    coords: [103.8198, 1.3521],
    targetRotation: [-103.8, -1.3],
    role: "Full Stack Engineer",
    tags: [
      { text: "Hybrid", variant: "neutral" },
      { text: "✓ Eligible: SG", variant: "success" },
    ],
  },
];

// Helper to calculate shortest spherical angle difference
function diffAngle(from: number, to: number): number {
  let diff = (to - from) % 360;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

export default function LandingGlobeFeatureSection() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Stats state from /api/stats
  const [stats, setStats] = useState<StatsData>({
    jobsToday: null,
    totalJobs: null,
    fetchStatus: "loading",
    lastFetchedAt: null,
  });
  const [refreshText, setRefreshText] = useState("fetching...");

  // Tour & interaction state
  const [isTouring, setIsTouring] = useState(true);
  const [activeCityIndex, setActiveCityIndex] = useState(0);
  const [tooltipPos, setTooltipPos] = useState<{
    x: number;
    y: number;
    visible: boolean;
    containerWidth: number;
  }>({
    x: 0,
    y: 0,
    visible: true,
    containerWidth: 440,
  });

  // State refs for animation loop
  const animFrameIdRef = useRef<number | null>(null);
  const isInViewRef = useRef(false);
  const isTouringRef = useRef(true);
  const activeCityIndexRef = useRef(0);
  const idleTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Rotation and momentum physics
  const currentRotationRef = useRef<[number, number]>([122.4, -37.7]);
  const startRotationRef = useRef<[number, number]>([122.4, -37.7]);
  const targetRotationRef = useRef<[number, number]>([122.4, -37.7]);
  const tourTransitionStartRef = useRef<number>(performance.now());
  const velocityRef = useRef<{ vx: number; vy: number }>({ vx: 0, vy: 0 });
  const isDraggingRef = useRef(false);
  const lastPointerRef = useRef<{ x: number; y: number; time: number }>({ x: 0, y: 0, time: 0 });
  const reducedMotionRef = useRef(false);

  // Cached GeoData & Land points
  const geoDataRef = useRef<any>(null);
  const landPointsRef = useRef<Array<[number, number]>>([]);

  // 1. Fetch live stats from /api/stats
  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/stats");
      if (!res.ok) throw new Error("Stats service unavailable");
      const data = await res.json();

      const totalJobs =
        typeof data.totalJobs === "number"
          ? data.totalJobs
          : typeof data.activeJobs === "number"
          ? data.activeJobs
          : null;

      const jobsToday = typeof data.jobsToday === "number" ? data.jobsToday : null;

      setStats({
        jobsToday,
        totalJobs,
        fetchStatus: "success",
        lastFetchedAt: Date.now(),
      });
      setRefreshText("just now");
    } catch {
      setStats((prev) => ({
        ...prev,
        fetchStatus: prev.lastFetchedAt ? "success" : "error",
      }));
      setRefreshText("offline");
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 60000); // 60s poll
    return () => clearInterval(interval);
  }, [fetchStats]);

  // Update relative time label ("just now", "1m ago", etc.)
  useEffect(() => {
    const updateLabel = () => {
      if (!stats.lastFetchedAt) return;
      const elapsedSec = Math.floor((Date.now() - stats.lastFetchedAt) / 1000);
      if (elapsedSec < 45) {
        setRefreshText("just now");
      } else {
        const mins = Math.floor(elapsedSec / 60);
        setRefreshText(`${mins}m ago`);
      }
    };
    const timeInterval = setInterval(updateLabel, 10000);
    return () => clearInterval(timeInterval);
  }, [stats.lastFetchedAt]);

  // Pause tour on user action and reset 6s idle resume timer
  const pauseTourAndResetTimer = useCallback(() => {
    isTouringRef.current = false;
    setIsTouring(false);

    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
    }

    idleTimerRef.current = setTimeout(() => {
      // Resume tour after 6s idle
      isTouringRef.current = true;
      setIsTouring(true);
      tourTransitionStartRef.current = performance.now();
      startRotationRef.current = [...currentRotationRef.current];
      const nextIdx = (activeCityIndexRef.current + 1) % TOUR_CITIES.length;
      activeCityIndexRef.current = nextIdx;
      setActiveCityIndex(nextIdx);
      targetRotationRef.current = [...TOUR_CITIES[nextIdx].targetRotation];
    }, 6000);
  }, []);

  const resumeTourImmediately = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    isTouringRef.current = true;
    setIsTouring(true);
    tourTransitionStartRef.current = performance.now();
    startRotationRef.current = [...currentRotationRef.current];
    const nextIdx = (activeCityIndexRef.current + 1) % TOUR_CITIES.length;
    activeCityIndexRef.current = nextIdx;
    setActiveCityIndex(nextIdx);
    targetRotationRef.current = [...TOUR_CITIES[nextIdx].targetRotation];
  }, []);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter"].includes(e.key)) {
        e.preventDefault();
      }

      if (e.key === "ArrowLeft") {
        pauseTourAndResetTimer();
        currentRotationRef.current[0] -= 5;
      } else if (e.key === "ArrowRight") {
        pauseTourAndResetTimer();
        currentRotationRef.current[0] += 5;
      } else if (e.key === "ArrowUp") {
        pauseTourAndResetTimer();
        currentRotationRef.current[1] = Math.min(70, currentRotationRef.current[1] + 5);
      } else if (e.key === "ArrowDown") {
        pauseTourAndResetTimer();
        currentRotationRef.current[1] = Math.max(-70, currentRotationRef.current[1] - 5);
      } else if (e.key === " " || e.key === "Enter") {
        resumeTourImmediately();
      }
    },
    [pauseTourAndResetTimer, resumeTourImmediately]
  );

  // 2. Globe setup and render loop
  useEffect(() => {
    reducedMotionRef.current =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let isCancelled = false;

    // Load land GeoJSON data
    async function loadGeoData() {
      try {
        const res = await fetch("/data/ne_110m_land.json");
        const json = await res.json();
        if (isCancelled) return;
        geoDataRef.current = json;

        // Sample land dots
        const features = json.features || [json];
        const points: Array<[number, number]> = [];
        const dotStep = 15; // 15-degree grid
        for (let lat = -75; lat <= 75; lat += dotStep) {
          for (let lon = -180; lon <= 180; lon += dotStep) {
            let onLand = false;
            for (const f of features) {
              if (d3.geoContains(f, [lon, lat])) {
                onLand = true;
                break;
              }
            }
            if (onLand) points.push([lon, lat]);
          }
        }
        landPointsRef.current = points;
      } catch (err) {
        console.error("Failed to load land GeoJSON", err);
      }
    }

    loadGeoData();

    // IntersectionObserver to pause rendering when offscreen
    const container = containerRef.current;
    if (container && typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver(
        (entries) => {
          isInViewRef.current = !!entries[0]?.isIntersecting;
        },
        { rootMargin: "100px" }
      );
      observer.observe(container);
    } else {
      isInViewRef.current = true;
    }

    // Canvas render loop
    const graticule = d3.geoGraticule10();
    const tourStepDuration = 3667; // ~11s for 3 cities (~3.66s per city)

    const render = () => {
      if (isCancelled) return;

      const canvas = canvasRef.current;
      const hostContainer = containerRef.current;

      if (!canvas || !hostContainer) {
        animFrameIdRef.current = requestAnimationFrame(render);
        return;
      }

      // Check offscreen pause
      if (!isInViewRef.current) {
        animFrameIdRef.current = requestAnimationFrame(render);
        return;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        animFrameIdRef.current = requestAnimationFrame(render);
        return;
      }

      const now = performance.now();
      const width = Math.min(hostContainer.clientWidth || 440, 460);
      const height = width;
      const dpr = window.devicePixelRatio || 1;

      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }

      // Physics update: Momentum / Inertia decay when user released drag
      if (!isDraggingRef.current) {
        if (Math.abs(velocityRef.current.vx) > 0.001 || Math.abs(velocityRef.current.vy) > 0.001) {
          currentRotationRef.current[0] += velocityRef.current.vx;
          currentRotationRef.current[1] = Math.max(
            -70,
            Math.min(70, currentRotationRef.current[1] - velocityRef.current.vy)
          );
          velocityRef.current.vx *= 0.92;
          velocityRef.current.vy *= 0.92;
        }
      }

      // Auto-Tour camera animation
      if (isTouringRef.current && !reducedMotionRef.current && !isDraggingRef.current) {
        const elapsed = now - tourTransitionStartRef.current;

        if (elapsed > tourStepDuration) {
          // Advance to next city
          tourTransitionStartRef.current = now;
          const nextIdx = (activeCityIndexRef.current + 1) % TOUR_CITIES.length;
          activeCityIndexRef.current = nextIdx;
          setActiveCityIndex(nextIdx);
          startRotationRef.current = [...currentRotationRef.current];
          targetRotationRef.current = [...TOUR_CITIES[nextIdx].targetRotation];
        } else {
          // Smooth spherical rotation transition in first 1.2s of each step
          const panDuration = 1200;
          const panProgress = Math.min(1, elapsed / panDuration);
          // Ease-in-out cosine
          const ease = 0.5 - 0.5 * Math.cos(Math.PI * panProgress);

          const startLon = startRotationRef.current[0];
          const targetLon = targetRotationRef.current[0];
          const diffLon = diffAngle(startLon, targetLon);

          currentRotationRef.current[0] = startLon + diffLon * ease;
          currentRotationRef.current[1] =
            startRotationRef.current[1] +
            (targetRotationRef.current[1] - startRotationRef.current[1]) * ease;
        }
      }

      // Setup orthographic projection
      const radius = (width / 2) * 0.82;
      const projection = d3
        .geoOrthographic()
        .scale(radius)
        .translate([width / 2, height / 2])
        .rotate(currentRotationRef.current)
        .clipAngle(90);

      const path = d3.geoPath(projection, ctx);

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      const centerX = width / 2;
      const centerY = height / 2;

      // 1. Ocean Sphere: Rich blue radial gradient (#2563EB to #1E3A8A)
      const oceanGrad = ctx.createRadialGradient(
        centerX - radius * 0.2,
        centerY - radius * 0.2,
        radius * 0.1,
        centerX,
        centerY,
        radius
      );
      oceanGrad.addColorStop(0, "#2563EB");
      oceanGrad.addColorStop(0.7, "#1D4ED8");
      oceanGrad.addColorStop(1, "#1E3A8A");

      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.fillStyle = oceanGrad;
      ctx.fill();

      // Atmospheric edge ring
      ctx.strokeStyle = "rgba(191, 219, 254, 0.4)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 2. Graticule lines (faint 15% opacity)
      ctx.beginPath();
      path(graticule);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
      ctx.lineWidth = 0.8;
      ctx.stroke();

      // 3. Land outlines (faint 18% opacity)
      if (geoDataRef.current) {
        ctx.beginPath();
        path(geoDataRef.current);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
        ctx.lineWidth = 0.9;
        ctx.stroke();
      }

      // 4. Continent Dotted Grid
      const centerCoord: [number, number] = [
        -currentRotationRef.current[0],
        -currentRotationRef.current[1],
      ];

      for (const ptCoord of landPointsRef.current) {
        const dist = d3.geoDistance(ptCoord, centerCoord);
        if (dist < Math.PI / 2) {
          const pt = projection(ptCoord);
          if (pt) {
            const opacity = Math.max(0.18, Math.cos(dist) * 0.75);
            ctx.beginPath();
            ctx.arc(pt[0], pt[1], 1.7, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, 255, 255, ${opacity.toFixed(2)})`;
            ctx.fill();
          }
        }
      }

      const activeCity = TOUR_CITIES[activeCityIndexRef.current];

      // 5. Great Circle Arc from Home (Bangalore Demo) to Active City
      if (activeCity) {
        const homeDist = d3.geoDistance(DEMO_HOME_COORDS, centerCoord);
        const cityDist = d3.geoDistance(activeCity.coords, centerCoord);

        // Calculate arc interpolation
        const interpolator = d3.geoInterpolate(DEMO_HOME_COORDS, activeCity.coords);
        const stepTime = (now - tourTransitionStartRef.current) % tourStepDuration;
        const arcProgress = reducedMotionRef.current
          ? 1
          : Math.min(1, Math.max(0, (stepTime - 400) / 1000));

        if (arcProgress > 0) {
          ctx.beginPath();
          ctx.setLineDash([4, 4]);
          ctx.lineDashOffset = -now * 0.02;
          ctx.strokeStyle = "rgba(147, 197, 253, 0.85)";
          ctx.lineWidth = 1.8;

          const arcSamples = 24;
          const maxSample = Math.floor(arcSamples * arcProgress);
          let started = false;

          for (let s = 0; s <= maxSample; s++) {
            const t = s / arcSamples;
            const coord = interpolator(t);
            const dist = d3.geoDistance(coord, centerCoord);
            if (dist < Math.PI / 2) {
              const p = projection(coord);
              if (p) {
                if (!started) {
                  ctx.moveTo(p[0], p[1]);
                  started = true;
                } else {
                  ctx.lineTo(p[0], p[1]);
                }
              }
            }
          }
          ctx.stroke();
          ctx.setLineDash([]); // Reset line dash
        }

        // Draw Home Marker (White dot)
        if (homeDist < Math.PI / 2) {
          const homePt = projection(DEMO_HOME_COORDS);
          if (homePt) {
            ctx.beginPath();
            ctx.arc(homePt[0], homePt[1], 3, 0, Math.PI * 2);
            ctx.fillStyle = "#FFFFFF";
            ctx.shadowColor = "#60A5FA";
            ctx.shadowBlur = 6;
            ctx.fill();
            ctx.shadowBlur = 0; // reset
          }
        }

        // Draw Active Target City Pin (Popping ring matching Jobright reference)
        if (cityDist < Math.PI / 2) {
          const cityPt = projection(activeCity.coords);
          if (cityPt) {
            const pulse = (Math.sin(now * 0.005) + 1) / 2; // 0 to 1
            const outerRadius = 7 + pulse * 5;

            // Outer expanding pulse ring
            ctx.beginPath();
            ctx.arc(cityPt[0], cityPt[1], outerRadius, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(239, 68, 68, ${(0.6 - pulse * 0.4).toFixed(2)})`;
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Inner red pin circle
            ctx.beginPath();
            ctx.arc(cityPt[0], cityPt[1], 4, 0, Math.PI * 2);
            ctx.fillStyle = "#EF4444";
            ctx.fill();
            ctx.strokeStyle = "#FFFFFF";
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Update HTML tooltip position
            setTooltipPos({
              x: cityPt[0],
              y: cityPt[1],
              visible: true,
              containerWidth: width,
            });
          } else {
            setTooltipPos((prev) => ({ ...prev, visible: false }));
          }
        } else {
          setTooltipPos((prev) => ({ ...prev, visible: false }));
        }
      }

      ctx.restore();
      animFrameIdRef.current = requestAnimationFrame(render);
    };

    animFrameIdRef.current = requestAnimationFrame(render);

    return () => {
      isCancelled = true;
      if (animFrameIdRef.current) {
        cancelAnimationFrame(animFrameIdRef.current);
      }
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
      }
    };
  }, []);

  // 3. Pointer and touch drag interactions with momentum
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    isDraggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    lastPointerRef.current = {
      x: e.clientX,
      y: e.clientY,
      time: performance.now(),
    };
    velocityRef.current = { vx: 0, vy: 0 };
    pauseTourAndResetTimer();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDraggingRef.current) return;
    const now = performance.now();
    const dt = Math.max(1, now - lastPointerRef.current.time);
    const dx = e.clientX - lastPointerRef.current.x;
    const dy = e.clientY - lastPointerRef.current.y;

    currentRotationRef.current[0] += dx * 0.45;
    currentRotationRef.current[1] = Math.max(
      -70,
      Math.min(70, currentRotationRef.current[1] - dy * 0.45)
    );

    velocityRef.current = {
      vx: (dx / dt) * 8,
      vy: (dy / dt) * 8,
    };

    lastPointerRef.current = { x: e.clientX, y: e.clientY, time: now };
    pauseTourAndResetTimer();
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    isDraggingRef.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    pauseTourAndResetTimer();
  };

  const currentCity = TOUR_CITIES[activeCityIndex];

  // Tooltip clamping & flip calculations
  const containerWidth = tooltipPos.containerWidth || 360;
  const isDesktop = containerWidth >= 440;
  const cardHalfWidth = isDesktop ? 100 : 85;
  const clampLeft = Math.max(
    cardHalfWidth + 10,
    Math.min(containerWidth - cardHalfWidth - 10, tooltipPos.x)
  );
  const isFlippedDown = tooltipPos.y < 110;

  return (
    <section
      data-testid="landing-globe-feature-section"
      aria-label="Global Coverage Feature"
      className="max-w-6xl mx-auto px-4 py-12 sm:py-20"
    >
      {/* 1. Centered Headline / Subtitle Stack */}
      <div className="text-center space-y-2 sm:space-y-3 mb-6 sm:mb-9">
        <div className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full text-xs font-semibold tracking-wider uppercase bg-blue-50/80 text-blue-700 border border-blue-200/80 shadow-2xs">
          <span>Global Map / Radar</span>
        </div>
        <h2 className="text-2xl xs:text-3xl sm:text-4xl lg:text-[42px] font-black text-[#090E34] tracking-tight leading-tight max-w-2xl mx-auto">
          Your next role might be in a city you haven&apos;t thought of yet.
        </h2>
        <p className="text-slate-600 text-sm sm:text-base lg:text-lg max-w-xl mx-auto leading-relaxed">
          Look beyond your radar. Explore jobs by city, with work setup and eligibility checked.
        </p>
      </div>

      {/* 2. Interactive 3D Orthographic Globe Container */}
      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        aria-label="Interactive 3D job radar globe. Use arrow keys to rotate, Enter or Space to resume tour."
        className="relative w-full max-w-[420px] sm:max-w-[460px] aspect-square mx-auto my-4 sm:my-6 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-full select-none"
      >
        {/* Soft Ambient Radial Blue Glow behind sphere */}
        <div
          aria-hidden="true"
          className="absolute inset-4 rounded-full bg-blue-600/25 blur-3xl pointer-events-none"
        />

        {/* Canvas 2D Globe */}
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="relative z-10 w-full h-full cursor-grab active:cursor-grabbing rounded-full touch-none"
        />

        {/* Top-Right Control: "Drag to explore" hint / "Resume tour" button */}
        <div className="absolute -top-4 right-1 sm:-top-2 sm:right-2 z-30">
          {isTouring ? (
            <button
              type="button"
              onClick={pauseTourAndResetTimer}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/95 hover:bg-white text-slate-700 shadow-md border border-slate-200/90 backdrop-blur-xs transition-all hover:scale-105 cursor-pointer"
            >
              <Compass className="w-3.5 h-3.5 text-blue-600" />
              <span>Drag to explore</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={resumeTourImmediately}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-md transition-all hover:scale-105 cursor-pointer"
            >
              <Play className="w-3 h-3 fill-current" />
              <span>Resume tour</span>
            </button>
          )}
        </div>

        {/* "Illustrative preview" subtle pill at bottom of globe */}
        <div
          aria-hidden="true"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 text-[11px] font-medium text-slate-500 bg-white/90 backdrop-blur-xs px-2.5 py-0.5 rounded-full border border-slate-200/80 shadow-2xs pointer-events-none"
        >
          Illustrative preview
        </div>

        {/* Floating Job Tooltip Overlay (matching Jobright reference) */}
        {tooltipPos.visible && currentCity && (
          <div
            style={{
              left: `${clampLeft}px`,
              top: `${tooltipPos.y}px`,
              transform: isFlippedDown
                ? "translate(-50%, 14px)"
                : "translate(-50%, calc(-100% - 12px))",
            }}
            className="absolute z-30 pointer-events-none transition-all duration-300 ease-out"
          >
            <div className="bg-white/95 backdrop-blur-md rounded-xl sm:rounded-2xl border border-slate-200/90 shadow-lg sm:shadow-xl p-2.5 sm:p-3 w-[165px] xs:w-[175px] sm:w-[200px] text-left">
              <div className="flex items-center justify-between gap-1 mb-0.5 sm:mb-1">
                <span className="text-xs sm:text-[13px] font-bold text-[#090E34] truncate">
                  {currentCity.name}
                </span>
                <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider bg-slate-100/90 px-1 py-0.2 rounded shrink-0">
                  Sample
                </span>
              </div>
              <div className="text-[11px] sm:text-xs text-slate-600 font-medium leading-tight mb-1.5 sm:mb-2 break-words">
                {currentCity.role}
              </div>
              <div className="flex flex-wrap gap-1 sm:gap-1.5">
                {currentCity.tags.map((tag, idx) => (
                  <span
                    key={idx}
                    className={`inline-flex items-center text-[10px] sm:text-[10.5px] font-medium px-1.5 py-0.5 rounded leading-tight break-words ${
                      tag.variant === "warning"
                        ? "bg-rose-50 text-rose-700 border border-rose-200/70"
                        : tag.variant === "success"
                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200/70"
                        : "bg-slate-100 text-slate-700 border border-slate-200/60"
                    }`}
                  >
                    {tag.text}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 3. Three-Cell Rounded Stats Strip (STRICT: NO COMPANY COUNT) */}
      <div className="mt-5 sm:mt-7 max-w-lg mx-auto bg-white/95 backdrop-blur-xs rounded-2xl border border-slate-200/90 shadow-xs px-3 sm:px-6 py-2.5 sm:py-3.5 flex items-center justify-between gap-2 sm:gap-4">
        {/* Cell 1: Fetch Status & Truthful Refresh Time */}
        <div className="flex-1 text-center min-w-0">
          <div className="flex items-center justify-center gap-1.5 mb-0.5">
            <span
              className={`w-2 h-2 rounded-full ${
                stats.fetchStatus === "success"
                  ? "bg-emerald-500 animate-pulse"
                  : stats.fetchStatus === "loading"
                  ? "bg-blue-500"
                  : "bg-amber-500"
              }`}
            />
            <span className="text-[11px] sm:text-xs font-bold uppercase tracking-wider text-slate-700">
              {stats.fetchStatus === "error" ? "Offline" : "Fetched"}
            </span>
          </div>
          <div className="text-[11px] sm:text-xs text-slate-500 truncate">{refreshText}</div>
        </div>

        <div className="w-px h-8 bg-slate-200 shrink-0" aria-hidden="true" />

        {/* Cell 2: Real Active Jobs count from /api/stats */}
        <div className="flex-1 text-center min-w-0">
          <div className="text-xl sm:text-2xl font-black text-[#090E34] tracking-tight">
            {typeof stats.totalJobs === "number" ? stats.totalJobs.toLocaleString() : "—"}
          </div>
          <div className="text-[11px] sm:text-xs text-slate-500 font-medium">Jobs</div>
        </div>

        <div className="w-px h-8 bg-slate-200 shrink-0" aria-hidden="true" />

        {/* Cell 3: Real Jobs Today count from /api/stats (0 displays 0) */}
        <div className="flex-1 text-center min-w-0">
          <div className="text-xl sm:text-2xl font-black text-[#090E34] tracking-tight">
            {typeof stats.jobsToday === "number" ? stats.jobsToday.toLocaleString() : "—"}
          </div>
          <div className="text-[11px] sm:text-xs text-slate-500 font-medium">New today</div>
        </div>
      </div>

      {/* 4. Dark Pill CTA Button + Descriptive Caption */}
      <div className="mt-5 sm:mt-7 flex flex-col items-center justify-center gap-2 sm:gap-2.5">
        <Link
          href="/jobs"
          className="inline-flex items-center justify-center gap-2 bg-[#090E34] hover:bg-[#1E293B] text-white font-semibold text-sm sm:text-base px-7 py-3 sm:px-8 sm:py-3.5 rounded-full shadow-md hover:shadow-lg transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 cursor-pointer"
        >
          <span>View jobs</span>
          <ArrowRight className="w-4 h-4 ml-0.5" />
        </Link>
        <Link
          href="/radar"
          className="text-xs text-slate-500 hover:text-slate-800 transition-colors underline-offset-2 hover:underline"
        >
          Open interactive map · sign-in required
        </Link>
      </div>
    </section>
  );
}
