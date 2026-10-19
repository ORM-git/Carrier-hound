"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

interface WireframeDottedGlobeProps {
  className?: string;
}

export function WireframeDottedGlobe({ className }: WireframeDottedGlobeProps) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [isInView, setIsInView] = useState(false);

  // Lazy-load: Observe container intersection so offscreen globe never eagerly downloads assets
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (typeof IntersectionObserver === "undefined") {
      setIsInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setIsInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isInView) return;

    let animId: number;
    let isCancelled = false;

    async function initGlobe() {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // 1. Fetch GeoJSON and d3 dynamically ONLY when scrolled into view
      let geoData: any = null;
      let d3: any = null;
      try {
        const [d3Module, res] = await Promise.all([
          import("d3"),
          fetch("/data/ne_110m_land.json").then((r) => r.json()),
        ]);
        d3 = d3Module;
        geoData = res;
      } catch (err) {
        console.error("[WireframeDottedGlobe] Failed to load globe data:", err);
        setLoading(false);
        return;
      }

      if (isCancelled || !geoData || !d3) return;
      setLoading(false);

      // 2. Dense dots with spacing 16
      const dotSpacing = 16;

      // Sparkling multicolor palette for land dots in rotation
      const dotColors = ["#FFFFFF", "#22D3EE", "#F59E0B", "#A78BFA"];

      // 3. Pre-sample points on land with assigned rotation color
      const landPoints: { coords: [number, number]; color: string }[] = [];
      const features = geoData.features || [geoData];
      let colorIdx = 0;

      for (let lat = -80; lat <= 80; lat += dotSpacing) {
        for (let lon = -180; lon <= 180; lon += dotSpacing) {
          let onLand = false;
          for (const feat of features) {
            if (d3.geoContains(feat, [lon, lat])) {
              onLand = true;
              break;
            }
          }
          if (onLand) {
            landPoints.push({
              coords: [lon, lat],
              color: dotColors[colorIdx % dotColors.length],
            });
            colorIdx++;
          }
        }
      }

      // 4. Hotspots (Silicon Valley, Bangalore, London, Tokyo, Berlin, Singapore)
      const hotspots: { name: string; coords: [number, number] }[] = [
        { name: "Silicon Valley", coords: [-122.0838, 37.3861] },
        { name: "Bangalore", coords: [77.5946, 12.9716] },
        { name: "London", coords: [-0.1276, 51.5074] },
        { name: "Tokyo", coords: [139.6917, 35.6895] },
        { name: "Berlin", coords: [13.405, 52.52] },
        { name: "Singapore", coords: [103.8198, 1.3521] },
      ];

      // 5. State for rotation and tap-to-3D interaction (zoom in/out disabled)
      let rotation: [number, number] = [-20, -15];
      const scaleRatio = 1.0; // Fixed scale - no zoom in / zoom out
      let isDragging = false;
      let lastX = 0;
      let lastY = 0;
      let startX = 0;
      let startY = 0;
      let totalMovement = 0;

      // Mouse drag and tap handlers
      const onMouseDown = (e: MouseEvent) => {
        isDragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        startX = e.clientX;
        startY = e.clientY;
        totalMovement = 0;
      };

      const onMouseMove = (e: MouseEvent) => {
        if (!isDragging) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        totalMovement += Math.hypot(dx, dy);
        rotation[0] += dx * 0.4;
        rotation[1] = Math.max(-75, Math.min(75, rotation[1] - dy * 0.4));
        lastX = e.clientX;
        lastY = e.clientY;
      };

      const onMouseUp = () => {
        if (isDragging && totalMovement < 8) {
          // Tap / click without dragging -> go to 3D Radar!
          router.push("/radar");
        }
        isDragging = false;
      };

      // Touch handlers (drag-to-rotate, tap-to-3D, zero zoom)
      const onTouchStart = (e: TouchEvent) => {
        if (e.touches.length === 1) {
          isDragging = true;
          lastX = e.touches[0].clientX;
          lastY = e.touches[0].clientY;
          startX = e.touches[0].clientX;
          startY = e.touches[0].clientY;
          totalMovement = 0;
        }
      };

      const onTouchMove = (e: TouchEvent) => {
        if (!isDragging || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - lastX;
        const dy = e.touches[0].clientY - lastY;

        // If gesture is vertical, allow the browser to scroll the page naturally
        if (Math.abs(dy) > Math.abs(dx) && totalMovement < 15) {
          isDragging = false;
          return;
        }

        totalMovement += Math.hypot(dx, dy);
        rotation[0] += dx * 0.4;
        rotation[1] = Math.max(-75, Math.min(75, rotation[1] - dy * 0.4));
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
        if (e.cancelable) e.preventDefault();
      };

      const onTouchEnd = () => {
        if (isDragging && totalMovement < 10) {
          // Tap on touch device -> go to 3D Radar!
          router.push("/radar");
        }
        isDragging = false;
      };

      canvas.addEventListener("mousedown", onMouseDown);
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);

      canvas.addEventListener("touchstart", onTouchStart, { passive: false });
      canvas.addEventListener("touchmove", onTouchMove, { passive: false });
      canvas.addEventListener("touchend", onTouchEnd);
      canvas.addEventListener("touchcancel", onTouchEnd);

      // 6. Render loop
      const graticule = d3.geoGraticule10();

      const render = () => {
        if (isCancelled) return;

        // Auto rotate when user is not dragging
        if (!isDragging) {
          rotation[0] += 0.25;
        }

        const width = container.clientWidth || 400;
        const height = width;
        const dpr = window.devicePixelRatio || 1;

        if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
          canvas.width = width * dpr;
          canvas.height = height * dpr;
          canvas.style.width = `${width}px`;
          canvas.style.height = `${height}px`;
        }

        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, width, height);

        const radius = (width / 2) * 0.82 * scaleRatio;
        const projection = d3
          .geoOrthographic()
          .scale(radius)
          .translate([width / 2, height / 2])
          .rotate(rotation)
          .clipAngle(90);

        const path = d3.geoPath(projection, ctx);

        // 1. Ocean circle: radial gradient from #2563EB (center) to #1E3A8A (edge) with white 2px outline
        const oceanGrad = ctx.createRadialGradient(
          width / 2,
          height / 2,
          0,
          width / 2,
          height / 2,
          radius
        );
        oceanGrad.addColorStop(0, "#2563EB");
        oceanGrad.addColorStop(1, "#1E3A8A");

        ctx.beginPath();
        ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
        ctx.fillStyle = oceanGrad;
        ctx.fill();
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 2;
        ctx.stroke();

        // 2. Graticule lines (white at 30% opacity)
        ctx.beginPath();
        path(graticule);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
        ctx.lineWidth = 0.8;
        ctx.stroke();

        // 3. Land outlines (white at 30% opacity)
        if (geoData) {
          ctx.beginPath();
          path(geoData);
          ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // 4. Land Dots: Sparkle multicolor (#FFFFFF, #22D3EE, #F59E0B, #A78BFA)
        const center: [number, number] = [-rotation[0], -rotation[1]];
        for (const item of landPoints) {
          const dist = d3.geoDistance(item.coords, center);
          if (dist < Math.PI / 2) {
            const pt = projection(item.coords);
            if (pt) {
              const [x, y] = pt;
              const opacity = Math.max(0.25, Math.cos(dist));
              ctx.save();
              ctx.globalAlpha = opacity;
              ctx.beginPath();
              ctx.arc(x, y, 1.85, 0, Math.PI * 2);
              ctx.fillStyle = item.color;
              ctx.fill();
              ctx.restore();
            }
          }
        }

        // 5. Hotspots (Silicon Valley, Bangalore, etc.) with bright pulse
        const time = Date.now() * 0.003;
        for (const spot of hotspots) {
          const dist = d3.geoDistance(spot.coords, center);
          if (dist < Math.PI / 2) {
            const pt = projection(spot.coords);
            if (pt) {
              const [x, y] = pt;
              const pulse = (Math.sin(time + spot.coords[0]) + 1) / 2;

              // Pulse ring
              ctx.beginPath();
              ctx.arc(x, y, 4 + pulse * 6, 0, Math.PI * 2);
              ctx.strokeStyle = `rgba(255, 255, 255, ${0.85 - pulse * 0.5})`;
              ctx.lineWidth = 1.4;
              ctx.stroke();

              // Solid center dot
              ctx.beginPath();
              ctx.arc(x, y, 3.2, 0, Math.PI * 2);
              ctx.fillStyle = "#FFFFFF";
              ctx.fill();
            }
          }
        }

        ctx.restore();
        animId = requestAnimationFrame(render);
      };

      animId = requestAnimationFrame(render);

      return () => {
        canvas.removeEventListener("mousedown", onMouseDown);
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);

        canvas.removeEventListener("touchstart", onTouchStart);
        canvas.removeEventListener("touchmove", onTouchMove);
        canvas.removeEventListener("touchend", onTouchEnd);
        canvas.removeEventListener("touchcancel", onTouchEnd);
      };
    }

    let cleanupFn: (() => void) | undefined;
    initGlobe().then((cleanup) => {
      cleanupFn = cleanup;
    });

    return () => {
      isCancelled = true;
      if (animId) cancelAnimationFrame(animId);
      if (cleanupFn) cleanupFn();
    };
  }, [router, isInView]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative w-full aspect-square flex items-center justify-center select-none cursor-pointer group",
        className
      )}
    >
      <canvas ref={canvasRef} className="w-full h-full block cursor-pointer touch-pan-y" />

      {/* Interactive tap badge to launch 3D radar */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 pointer-events-auto">
        <button
          onClick={(e) => {
            e.stopPropagation();
            router.push("/radar");
          }}
          className="inline-flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-full text-xs font-semibold bg-white/95 text-blue-600 border border-blue-200/80 shadow-md backdrop-blur-sm hover:bg-blue-50 hover:border-blue-300 transition-all cursor-pointer group-hover:scale-105 active:scale-95"
        >
          <span className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
          <span>Tap for 3D Radar ↗</span>
        </button>
      </div>

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50">
          <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        </div>
      )}
    </div>
  );
}

export default WireframeDottedGlobe;
