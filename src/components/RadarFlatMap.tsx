"use client";
import React, { useEffect, useRef, useState } from "react";
import type { RadarCityAggregate } from "@/data/radarCities";
import { placeFlatRadarCities } from "@/lib/jobs/radarView";
export default function RadarFlatMap({
  cities,
  zoom,
  onSelect,
}: {
  cities: RadarCityAggregate[];
  zoom: number;
  onSelect: (city: RadarCityAggregate) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 600 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setSize({ width: el.clientWidth, height: el.clientHeight })
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const width = Math.max(780, size.width) * zoom,
    height = Math.max(size.height, 390) * zoom;
  return (
    <div ref={ref} className="radar-flat-map" aria-label="Flat job map">
      <div className="radar-flat-map-content" style={{ width, height }}>
        <img src="/globe/earth-radar-boundaries.png" alt="World map" />
        {placeFlatRadarCities(cities, width, height).map((city) => (
          <button
            key={city.id}
            aria-label={`View ${city.totalCount} active jobs in ${city.name}`}
            onClick={() => onSelect(city)}
            style={{
              left: `${(city.coordinates[0] + 180) / 3.6}%`,
              top: `${(90 - city.coordinates[1]) / 1.8}%`,
            }}
          >
            {city.totalCount.toLocaleString()}
            <small>{city.name}</small>
          </button>
        ))}
      </div>
      <p className="radar-flat-map-note">
        Scroll to explore · Zoom for more cities · All locations in List
      </p>
    </div>
  );
}
