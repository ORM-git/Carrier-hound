"use client";

import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  RadarCityAggregate,
  RadarTelemetryPayload,
  RadarJobCard,
  CountryRegion,
  RADAR_REGIONS,
  getMarkerRadius,
} from "@/data/radarCities";
import { CANONICAL_CATEGORIES } from "@/lib/taxonomy";
import { createClient } from "@/lib/supabase/client";
import PaywallModal from "@/components/PaywallModal";
import CompanyLogo from "@/components/CompanyLogo";
import {
  RotateCw,
  RotateCcw,
  MapPin,
  ExternalLink,
  DollarSign,
  Clock,
  X,
  ChevronRight,
  ShieldCheck,
  Radio,
  CheckCircle2,
  Compass,
  Globe2,
  Filter,
  Layers,
  AlertCircle,
  Search,
  ChevronDown,
  Loader2,
  Sparkles,
  Lock,
  GraduationCap,
  SlidersHorizontal,
  BookmarkPlus,
} from "lucide-react";
import MatchScoreBadge from "@/components/matcher/MatchScoreBadge";
import { quickTrackJob } from "@/lib/tracker/storage";
import { getProAccessStatus } from "@/lib/billing/subscription";
import { sanitizeExternalUrl } from "@/lib/security/xss";
import { toast } from "react-toastify";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { VISIBLE_SOURCE_FILTER } from "@/lib/jobs/sourcePolicy";

// Convert latitude and longitude to 3D Cartesian coordinates on sphere
function latLngToVector3(lat: number, lng: number, radius: number = 5) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  const x = -(radius * Math.sin(phi) * Math.cos(theta));
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);
  return { x, y, z };
}

// Reusable scratch vectors for 60 FPS marker projection loop to prevent heap allocation & GC thrash
const scratchWorldPos = new THREE.Vector3();
const scratchMarkerDir = new THREE.Vector3();
const scratchScreenVec = new THREE.Vector3();

// Region & Country matching helper for filtering cities on globe
function matchesFilters(
  city: RadarCityAggregate,
  countryFilter: string,
  regionFilter: string
): boolean {
  // Specific country filter takes priority
  if (countryFilter !== "all") {
    return city.countryCode.toLowerCase() === countryFilter.toLowerCase();
  }
  // Region filter fallback
  if (regionFilter === "all") return true;
  if (regionFilter === "US") return city.countryCode === "US";
  if (regionFilter === "IN") return city.countryCode === "IN";
  if (regionFilter === "EU") return city.region === "europe";
  if (regionFilter === "APAC") return city.region === "asia_pac";
  return city.countryCode.toLowerCase() === regionFilter.toLowerCase();
}

// Date formatter
function formatJobDate(dateStr: string | null): string {
  if (!dateStr) return "Recently seen";
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours < 1) return "Just now";
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 30) return `${diffDays}d ago`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "Recently";
  }
}

// Deterministic company gradient avatar
const COMPANY_GRADIENTS = [
  "from-cyan-600 to-blue-600",
  "from-violet-600 to-indigo-600",
  "from-emerald-600 to-teal-600",
  "from-amber-600 to-orange-600",
  "from-rose-600 to-pink-600",
  "from-indigo-600 to-cyan-600",
];

function getCompanyGradient(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COMPANY_GRADIENTS[Math.abs(hash) % COMPANY_GRADIENTS.length];
}

// Check WebGL availability
function checkWebGLSupport(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext("webgl") || canvas.getContext("experimental-webgl"))
    );
  } catch {
    return false;
  }
}

interface ActiveSelection {
  id: string;
  name: string;
  countryCode: string;
  totalCount: number;
  verifiedCount: number;
  coordinates?: [number, number];
  isWorldwideRemote?: boolean;
}

type GlobeMapStyle = "dots" | "night" | "satellite" | "minimal";

const GLOBE_MAP_TEXTURES: Record<GlobeMapStyle, string> = {
  // Dotted style tints the dark map as a base; its pure-black land pixels double as the dot mask.
  dots: "/globe/earth-dark.jpg",
  night: "/globe/earth-night.jpg",
  satellite: "/globe/earth-blue-marble.jpg",
  minimal: "/globe/earth-dark.jpg",
};

const GLOBE_MAP_LABELS: Record<GlobeMapStyle, string> = {
  dots: "Dotted",
  night: "Night",
  satellite: "Satellite",
  minimal: "Minimal Dark",
};

// Single teal/cyan marker color (replaces the old multi-hue density scale)
const MARKER_COLOR_HEX = 0x22d3ee;
const MARKER_COLOR_CSS = "#22d3ee";
const MARKER_GLOW_CSS = "rgba(34, 211, 238, 0.55)";
// Dotted style: land dots + the tint multiplied into the dark base map
const LAND_DOT_COLOR_HEX = 0x5eead4;
const DOTS_BASE_TINT = 0x7aa7e0;

const NAV_HINT_STORAGE_KEY = "cm_radar_nav_hint_dismissed";

// Creates a small canvas texture with a soft radial-gradient dot, so starfield
// points render as round sprites instead of square GL points.
function createCircleSpriteTexture(): THREE.Texture {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.4, "rgba(255,255,255,0.8)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

// Evenly spaced points on the sphere (Fibonacci lattice), kept only where isLand(lat, lng) is true.
export function fibonacciLandDots(
  samples: number,
  radius: number,
  isLand: (lat: number, lng: number) => boolean
): Float32Array {
  const out: number[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < samples; i++) {
    const y = 1 - (2 * (i + 0.5)) / samples;
    const lat = (Math.asin(y) * 180) / Math.PI;
    const lng = ((((i * golden * 180) / Math.PI) % 360) + 360) % 360 - 180;
    if (!isLand(lat, lng)) continue;
    const p = latLngToVector3(lat, lng, radius);
    out.push(p.x, p.y, p.z);
  }
  return new Float32Array(out);
}

// Land test from the equirectangular dark map, where land pixels are (near) pure black.
function landMaskFromImage(image: CanvasImageSource): (lat: number, lng: number) => boolean {
  const w = 720;
  const h = 360;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  return (lat, lng) => {
    const x = Math.min(w - 1, Math.floor(((lng + 180) / 360) * w));
    const y = Math.min(h - 1, Math.floor(((90 - lat) / 180) * h));
    const i = (y * w + x) * 4;
    return lat > -60 && px[i] + px[i + 1] + px[i + 2] < 24; // skip Antarctica, like stripe.com
  };
}

export default function JobRadarGlobe() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const containerRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Three.js instances
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const markersGroupRef = useRef<THREE.Group | null>(null);
  const selectionRingRef = useRef<THREE.Mesh | null>(null);
  const arcsGroupRef = useRef<THREE.Group | null>(null);
  const earthMaterialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const globeTexturesRef = useRef<Partial<Record<GlobeMapStyle, THREE.Texture>>>({});
  const bumpTextureRef = useRef<THREE.Texture | null>(null);
  const landDotsRef = useRef<THREE.Points | null>(null);
  const disposablesRef = useRef<Array<{ dispose: () => void }>>([]);

  // Camera animation target
  const targetCameraPosRef = useRef<THREE.Vector3 | null>(null);
  const targetLookAtRef = useRef<THREE.Vector3 | null>(null);
  const isTransitioningRef = useRef<boolean>(false);

  // Auto-rotate resume timer: idle rotation pauses on interaction, resumes ~4s after the last one
  const autoRotateResumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Direct DOM references for 60 FPS HTML marker transforms (ZERO React re-renders)
  const markerElementsRef = useRef<Map<string, HTMLButtonElement>>(new Map());

  // State
  const [webglSupported, setWebglSupported] = useState<boolean>(true);
  const [telemetry, setTelemetry] = useState<RadarTelemetryPayload | null>(null);
  const [isLoadingTelemetry, setIsLoadingTelemetry] = useState<boolean>(true);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [textureLoaded, setTextureLoaded] = useState<boolean>(false);
  // True once the initial earth texture load has settled (succeeded or failed), so the
  // full-screen loading overlay can clear even when the texture itself failed to load.
  const [textureLoadFailed, setTextureLoadFailed] = useState<boolean>(false);

  // Respect prefers-reduced-motion: no auto-rotate, no pulse animations
  const [prefersReducedMotion] = useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  // Map style layer switcher: night lights / satellite (day) / minimal dark
  const [mapStyle, setMapStyle] = useState<GlobeMapStyle>("dots");

  // "How to navigate" card: collapsible, auto-hides after first interaction, remembered in localStorage
  const [showNavHint, setShowNavHint] = useState<boolean>(true);

  // Mobile filter bottom sheet
  const [showMobileFilterSheet, setShowMobileFilterSheet] = useState<boolean>(false);

  // Hover tooltip (low-frequency UI state; fine as React state unlike the 60fps position loop)
  const [hoveredCity, setHoveredCity] = useState<RadarCityAggregate | null>(null);
  const [hoveredPos, setHoveredPos] = useState<{ x: number; y: number } | null>(null);

  // ==========================================
  // THE 4 LIGHT FILTERS (Radar Only)
  // ==========================================
  const [regionFilter, setRegionFilter] = useState<string>("all");
  const [countryFilter, setCountryFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [remoteFilter, setRemoteFilter] = useState<boolean>(false);
  const [internshipFilter, setInternshipFilter] = useState<boolean>(false);
  const [verifiedOnly, setVerifiedOnly] = useState<boolean>(false);

  // Free vs Pro Gating State
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [isPro, setIsPro] = useState<boolean>(false);
  const [isPaywallOpen, setIsPaywallOpen] = useState<boolean>(false);

  // Selection & UI State
  const [selectedCity, setSelectedCity] = useState<ActiveSelection | null>(null);
  const [isSpinning, setIsSpinning] = useState<boolean>(true);
  const [showLayersPanel, setShowLayersPanel] = useState<boolean>(false);

  // Drawer jobs state
  const [drawerJobs, setDrawerJobs] = useState<RadarJobCard[]>([]);
  const [jobsLoading, setJobsLoading] = useState<boolean>(false);
  const [jobsPage, setJobsPage] = useState<number>(1);
  const [jobsTotal, setJobsTotal] = useState<number>(0);
  const [jobsHasMore, setJobsHasMore] = useState<boolean>(false);
  const [appliedJobs, setAppliedJobs] = useState<Record<string, boolean>>({});
  const [radarProUnlockError, setRadarProUnlockError] = useState<boolean>(false);

  // Sync refs for animation loop
  const isSpinningRef = useRef<boolean>(true);
  isSpinningRef.current = isSpinning;

  const countryFilterRef = useRef<string>("all");
  countryFilterRef.current = countryFilter;

  const regionFilterRef = useRef<string>("all");
  regionFilterRef.current = regionFilter;

  const selectedCityRef = useRef<ActiveSelection | null>(null);
  selectedCityRef.current = selectedCity;

  const telemetryRef = useRef<RadarTelemetryPayload | null>(null);
  telemetryRef.current = telemetry;

  // 1. Check user auth & pro status on mount
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }: any) => {
      if (data?.user) {
        setCurrentUser(data.user);
      }
    });

    getProAccessStatus().then((res) => setIsPro(res.isPro));

    const handleSubUpdate = () => {
      getProAccessStatus().then((res) => setIsPro(res.isPro));
    };
    window.addEventListener("careermonke_pro_updated", handleSubUpdate);
    window.addEventListener("careermonke_auth_updated", handleSubUpdate);
    return () => {
      window.removeEventListener("careermonke_pro_updated", handleSubUpdate);
      window.removeEventListener("careermonke_auth_updated", handleSubUpdate);
    };
  }, []);

  // 2. Fetch live telemetry from /api/radar on mount (abortable on unmount)
  const lastTelemetryAtRef = useRef<number>(0);
  const fetchTelemetry = useCallback(async (signal?: AbortSignal) => {
    setIsLoadingTelemetry(true);
    setTelemetryError(null);
    try {
      let res = await fetch("/api/radar", { cache: "no-store", signal });
      if (!res.ok) {
        res = await fetch("/api/radar.json", { signal });
      }
      if (!res.ok) {
        res = await fetch("/data/radar.json", { signal });
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: Failed to load live telemetry`);
      }
      const data: RadarTelemetryPayload = await res.json();
      if (signal?.aborted) return;
      lastTelemetryAtRef.current = Date.now();
      setTelemetry(data);
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      console.error("Failed to load radar telemetry:", err);
      setTelemetryError(err.message || "Failed to load radar telemetry");
    } finally {
      if (!signal?.aborted) {
        setIsLoadingTelemetry(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchTelemetry(controller.signal);
    return () => controller.abort();
  }, [fetchTelemetry]);

  // Page Visibility API: refetch telemetry when the tab becomes visible
  // again and the data is older than 60s (animation pause/resume on
  // visibilitychange is handled in the WebGL effect below).
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastTelemetryAtRef.current > 60_000) {
        fetchTelemetry();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [fetchTelemetry]);

  // Check WebGL support on client
  useEffect(() => {
    setWebglSupported(checkWebGLSupport());
  }, []);

  // Restore "How to navigate" card dismissal from localStorage
  useEffect(() => {
    try {
      if (localStorage.getItem(NAV_HINT_STORAGE_KEY) === "true") {
        setShowNavHint(false);
      }
    } catch {
      // Storage denied (private mode, etc.) — keep the hint visible.
    }
  }, []);

  const dismissNavHint = useCallback(() => {
    setShowNavHint(false);
    try {
      localStorage.setItem(NAV_HINT_STORAGE_KEY, "true");
    } catch {}
  }, []);

  // 3. Initialize Filters from URL query params
  useEffect(() => {
    if (!telemetry) return;
    const initialCityParam = searchParams.get("city");
    const initialCountryParam = searchParams.get("country");
    const initialCatParam = searchParams.get("cat");
    const initialRemoteParam = searchParams.get("remote");
    const initialInternshipParam = searchParams.get("internship");

    if (initialCountryParam) setCountryFilter(initialCountryParam);
    if (initialCatParam) setCategoryFilter(initialCatParam);
    if (initialRemoteParam === "true") setRemoteFilter(true);
    if (initialInternshipParam === "true") setInternshipFilter(true);

    if (initialCityParam) {
      if (initialCityParam === "worldwide-remote" || initialCityParam === "remote") {
        setSelectedCity({
          id: "worldwide-remote",
          name: "Worldwide Remote",
          countryCode: "GLOBAL",
          totalCount: telemetry.worldwideRemote.totalCount,
          verifiedCount: telemetry.worldwideRemote.verifiedCount,
          isWorldwideRemote: true,
        });
      } else {
        const found = telemetry.cities.find(
          (c) =>
            c.id.toLowerCase() === initialCityParam.toLowerCase() ||
            c.name.toLowerCase() === initialCityParam.toLowerCase()
        );
        if (found) {
          setSelectedCity(found);
        }
      }
    }
  }, [telemetry, searchParams]);

  // 4. Update URL params whenever filters change
  const updateUrlFilters = useCallback(
    (updates: {
      country?: string;
      cat?: string;
      remote?: boolean;
      internship?: boolean;
    }) => {
      const c = updates.country !== undefined ? updates.country : countryFilter;
      const cat = updates.cat !== undefined ? updates.cat : categoryFilter;
      const rem = updates.remote !== undefined ? updates.remote : remoteFilter;
      const intern = updates.internship !== undefined ? updates.internship : internshipFilter;

      const p = new URLSearchParams();
      if (c && c !== "all") p.set("country", c);
      if (cat && cat !== "all") p.set("cat", cat);
      if (rem) p.set("remote", "true");
      if (intern) p.set("internship", "true");

      const newUrl = p.toString() ? `/radar?${p.toString()}` : "/radar";
      window.history.replaceState(null, "", newUrl);
    },
    [countryFilter, categoryFilter, remoteFilter, internshipFilter]
  );

  // 5. Reset all 4 Light Filters
  const handleResetAllFilters = () => {
    setCountryFilter("all");
    setRegionFilter("all");
    setCategoryFilter("all");
    setRemoteFilter(false);
    setInternshipFilter(false);
    setVerifiedOnly(false);
    setSelectedCity(null);
    window.history.replaceState(null, "", "/radar");
    handleResetOrbit();
  };

  const hasActiveFilters =
    countryFilter !== "all" ||
    regionFilter !== "all" ||
    categoryFilter !== "all" ||
    remoteFilter ||
    internshipFilter ||
    verifiedOnly;

  // 6. Fetch jobs for the selected city / worldwide remote drawer with 4 Light Filters
  const fetchCityJobs = useCallback(
    async (target: ActiveSelection, page: number = 1, append: boolean = false) => {
      setJobsLoading(true);
      setRadarProUnlockError(false);
      try {
        const supabase = createClient();
        const pageSize = 10;
        const offset = (page - 1) * pageSize;

        let query = supabase
          .from("jobs_public")
          .select(
            "id, title, company, location, country_code, remote_scope, remote_eligibility, job_type, salary_text, verified, source_type, apply_url, posted_at, discovered_at, last_seen_at, seniority, category",
            { count: "exact" }
          ).or(VISIBLE_SOURCE_FILTER)
          .eq("status", "active");

        // Target: City or Worldwide Remote
        if (target.isWorldwideRemote || target.id === "worldwide-remote") {
          query = query.or("remote_scope.eq.worldwide,location.ilike.%remote%");
        } else {
          query = query.ilike("location", `%${target.name}%`);
        }

        // Filter 1: Country (if specific country chosen)
        if (countryFilter !== "all") {
          query = query.eq("country_code", countryFilter.toUpperCase());
        }

        // Filter 2: Category
        if (categoryFilter !== "all") {
          const cleanCat = categoryFilter.replace(/[%_(),"'`;\\$*]/g, " ").trim();
          if (cleanCat) {
            query = query.or(`category.ilike.%${cleanCat}%,title.ilike.%${cleanCat}%`);
          }
        }

        // Filter 3: Remote Only
        if (remoteFilter) {
          query = query.or("remote_scope.eq.worldwide,remote_scope.eq.remote,location.ilike.%remote%");
        }

        // Filter 4: Internships Only
        if (internshipFilter) {
          query = query.or("job_type.eq.internship,title.ilike.%internship%,title.ilike.%internships%,title.ilike.% intern %,title.ilike.intern %,title.ilike.% intern,title.ilike.%-intern%,title.ilike.%(intern)%,title.ilike.%co-op%,title.ilike.%coop%");
        }

        // Verified Only Toggle
        if (verifiedOnly) {
          query = query.eq("verified", true);
        }

        const { data, count, error } = await query
          .order("discovered_at", { ascending: false, nullsFirst: false })
          .range(offset, offset + pageSize - 1);

        if (error) throw error;

        const cards: RadarJobCard[] = (data || []).map((row: any) => ({
          id: row.id,
          title: row.title || "Engineering Role",
          company: row.company || "Verified Company",
          location: row.location || "Remote",
          countryCode: row.country_code,
          remoteScope: row.remote_scope || "unknown",
          remoteEligibility: row.remote_eligibility || "unrestricted",
          jobType: (row.job_type || "full_time").replace("_", " "),
          salaryText: row.salary_text || null,
          verified: Boolean(row.verified),
          sourceType: row.source_type || "ats",
          applyUrl: row.apply_url || "#",
          postedAt: row.posted_at,
          discoveredAt: row.discovered_at,
          lastSeenAt: row.last_seen_at,
          seniority: row.seniority,
        }));

        // For verified Pro members, unlock full details from server
        if (isPro && cards.length > 0) {
          try {
            const { data: { session } } = await supabase.auth.getSession();
            const token = session?.access_token;
            if (token) {
              const proRes = await fetch("/api/jobs/pro", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ ids: cards.map((c) => c.id) }),
              });
              if (proRes.ok) {
                const proData = await proRes.json();
                if (Array.isArray(proData.jobs)) {
                  const unlockedMap = new Map<string, any>(
                    proData.jobs.map((pj: any) => [pj.id, pj])
                  );
                  cards.forEach((c) => {
                    const u = unlockedMap.get(c.id);
                    if (u) {
                      if (u.company) c.company = u.company;
                      if (u.salary_text) c.salaryText = u.salary_text;
                      if (u.apply_url) c.applyUrl = u.apply_url;
                    }
                  });
                }
                setRadarProUnlockError(false);
              } else {
                console.error(`[API /jobs/pro error]: Radar drawer Pro unlock failed with status ${proRes.status}`);
                if (proRes.status === 401) {
                  const { data: { session: currentSession } } = await supabase.auth.getSession();
                  if (!currentSession && typeof window !== "undefined") {
                    const returnTo = window.location.pathname + window.location.search;
                    window.location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`);
                  }
                }
                setRadarProUnlockError(true);
              }
            }
          } catch (proErr: any) {
            console.error(`[API /jobs/pro error]: Radar drawer Pro unlock failure (${proErr?.message || "fetch failed"})`);
            setRadarProUnlockError(true);
          }
        }

        if (append) {
          setDrawerJobs((prev) => [...prev, ...cards]);
        } else {
          setDrawerJobs(cards);
        }

        const total = count ?? cards.length;
        setJobsTotal(total);
        setJobsHasMore(offset + pageSize < total);
        setJobsPage(page);
      } catch (err: any) {
        console.error("Error fetching jobs for city:", err);
      } finally {
        setJobsLoading(false);
      }
    },
    [countryFilter, categoryFilter, remoteFilter, internshipFilter, verifiedOnly]
  );

  // Trigger drawer fetch when selectedCity or any filter changes
  useEffect(() => {
    setRadarProUnlockError(false);
    if (selectedCity) {
      fetchCityJobs(selectedCity, 1, false);
    } else {
      setDrawerJobs([]);
      setJobsTotal(0);
      setJobsHasMore(false);
    }
  }, [selectedCity, fetchCityJobs]);

  // 7. Handle Locked / Pro item clicks
  const handleLockedClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!currentUser) {
      const currentPath =
        typeof window !== "undefined"
          ? window.location.pathname + window.location.search
          : "/radar";
      router.push(`/login?returnTo=${encodeURIComponent(currentPath)}`);
    } else {
      setIsPaywallOpen(true);
    }
  };

  // Quick Track Job Application
  const handleTrackJob = async (job: RadarJobCard) => {
    try {
      await quickTrackJob(
        {
          id: job.id,
          title: job.title,
          company: job.company,
          location: job.location,
          salary_text: job.salaryText || undefined,
          apply_url: job.applyUrl,
        },
        "saved"
      );
      toast.success(`"${job.title}" saved to Application Tracker!`);
    } catch (err) {
      toast.error("Could not add to tracker");
    }
  };

  // 7b. Swap the earth texture when the user picks a different map style (night / satellite / minimal).
  // Declared before the main WebGL effect so it isn't the file's last cleanup-returning effect; it
  // no-ops on initial mount (earthMaterialRef/rendererRef aren't set yet) and reacts once mapStyle
  // actually changes, by which point the main effect has already run and populated those refs.
  useEffect(() => {
    if (landDotsRef.current) landDotsRef.current.visible = mapStyle === "dots";
    const earthMat = earthMaterialRef.current;
    const renderer = rendererRef.current;
    if (!earthMat || !renderer) return;
    earthMat.color.set(mapStyle === "dots" ? DOTS_BASE_TINT : 0xffffff);

    const cached = globeTexturesRef.current[mapStyle];
    if (cached) {
      earthMat.map = cached;
      earthMat.needsUpdate = true;
      return;
    }

    let cancelled = false;
    new THREE.TextureLoader().load(GLOBE_MAP_TEXTURES[mapStyle], (texture) => {
      if (cancelled) {
        texture.dispose();
        return;
      }
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      texture.colorSpace = THREE.SRGBColorSpace;
      globeTexturesRef.current[mapStyle] = texture;
      disposablesRef.current.push(texture);
      earthMat.map = texture;
      earthMat.needsUpdate = true;
    });
    return () => {
      cancelled = true;
    };
  }, [mapStyle]);

  // 7c. Worldwide Remote: animated hub-and-spoke arcs between top cities. Declared
  // before the main WebGL effect for the same reason as 7b above (arcsGroupRef isn't
  // set until that effect runs; this one no-ops harmlessly until selectedCity changes).
  useEffect(() => {
    const group = arcsGroupRef.current;
    if (!group) return;

    while (group.children.length > 0) {
      const child = group.children[0] as THREE.Mesh;
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
      group.remove(child);
    }

    // Thin static arcs between top hubs always; Worldwide Remote brightens and pulses them.
    if (!telemetry) return;
    const isRemote = Boolean(selectedCity?.isWorldwideRemote);

    const topCities = [...telemetry.cities].sort((a, b) => b.totalCount - a.totalCount).slice(0, 7);
    if (topCities.length < 2) return;

    const hub = topCities[0];
    const hubXYZ = latLngToVector3(hub.coordinates[1], hub.coordinates[0], 5.01);
    const hubVec = new THREE.Vector3(hubXYZ.x, hubXYZ.y, hubXYZ.z);

    const materials: THREE.MeshBasicMaterial[] = [];
    for (const city of topCities.slice(1)) {
      const cityXYZ = latLngToVector3(city.coordinates[1], city.coordinates[0], 5.01);
      const cityVec = new THREE.Vector3(cityXYZ.x, cityXYZ.y, cityXYZ.z);
      const mid = hubVec.clone().add(cityVec).multiplyScalar(0.5);
      const liftScale = 5.01 + hubVec.distanceTo(cityVec) * 0.35;
      mid.normalize().multiplyScalar(liftScale);

      const curve = new THREE.QuadraticBezierCurve3(hubVec, mid, cityVec);
      const tubeGeo = new THREE.TubeGeometry(curve, 48, isRemote ? 0.012 : 0.007, 4, false);
      const tubeMat = new THREE.MeshBasicMaterial({
        color: MARKER_COLOR_HEX,
        transparent: true,
        opacity: isRemote ? 0.35 : 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const tube = new THREE.Mesh(tubeGeo, tubeMat);
      group.add(tube);
      materials.push(tubeMat);
    }

    if (!isRemote || prefersReducedMotion) return;

    // Subtle breathing pulse; independent of the main render loop (which still draws every frame)
    let rafId: number;
    const start = performance.now();
    const pulse = () => {
      const t = (performance.now() - start) / 1000;
      materials.forEach((m, i) => {
        m.opacity = 0.25 + 0.2 * Math.sin(t * 1.4 + i * 0.6);
      });
      rafId = requestAnimationFrame(pulse);
    };
    pulse();

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [telemetry, selectedCity, prefersReducedMotion]);

  // 8. Initialize Three.js 3D Globe with 60 FPS zero-rerender animation loop
  useEffect(() => {
    if (!webglSupported || !containerRef.current) return;

    let isCancelled = false;
    const container = containerRef.current;
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight - 64;

    const isMobile = width < 640;
    const dpr = Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2);

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Scene, Camera, Renderer
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(0, isMobile ? 1.8 : 4.8, isMobile ? 18 : 17);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: !isMobile,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(dpr);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    rendererRef.current = renderer;

    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    // OrbitControls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.rotateSpeed = 0.6;
    controls.zoomSpeed = 0.8;
    controls.minDistance = 6.8;
    controls.maxDistance = 32;
    controls.autoRotate = !prefersReducedMotion && isSpinningRef.current;
    controls.autoRotateSpeed = 0.75;
    controlsRef.current = controls;

    controls.addEventListener("start", () => {
      isTransitioningRef.current = false;
      setIsSpinning(false);
      dismissNavHint();

      // Idle auto-rotate resumes ~4s after the last interaction (unless a city is open)
      if (autoRotateResumeTimeoutRef.current) clearTimeout(autoRotateResumeTimeoutRef.current);
      if (!prefersReducedMotion) {
        autoRotateResumeTimeoutRef.current = setTimeout(() => {
          if (!selectedCityRef.current) setIsSpinning(true);
        }, 4000);
      }
    });

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.4);
    scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0x7dd3fc, 1.6);
    sunLight.position.set(12, 8, 14);
    scene.add(sunLight);

    const backLight = new THREE.DirectionalLight(0x0284c7, 0.8);
    backLight.position.set(-10, -5, -10);
    scene.add(backLight);

    // Starfield: round sprite points (not square GL points), fine twinkling via per-point size jitter
    const spriteTexture = createCircleSpriteTexture();
    const starsCount = isMobile ? 600 : 1600;
    const starsGeo = new THREE.BufferGeometry();
    const starPositions = new Float32Array(starsCount * 3);
    const starSizes = new Float32Array(starsCount);
    for (let i = 0; i < starsCount; i++) {
      starPositions[i * 3] = (Math.random() - 0.5) * 220;
      starPositions[i * 3 + 1] = (Math.random() - 0.5) * 220;
      starPositions[i * 3 + 2] = (Math.random() - 0.5) * 220;
      starSizes[i] = 0.35 + Math.random() * 0.75;
    }
    starsGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    starsGeo.setAttribute("size", new THREE.BufferAttribute(starSizes, 1));
    const starsMat = new THREE.PointsMaterial({
      color: 0xbfdbfe,
      size: 0.7,
      map: spriteTexture,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const starField = new THREE.Points(starsGeo, starsMat);
    scene.add(starField);
    disposablesRef.current.push(starsGeo, starsMat, spriteTexture);

    // Deep space gradient background (radial, behind the starfield)
    const bgCanvas = document.createElement("canvas");
    bgCanvas.width = 2;
    bgCanvas.height = 256;
    const bgCtx = bgCanvas.getContext("2d")!;
    const bgGradient = bgCtx.createLinearGradient(0, 0, 0, 256);
    bgGradient.addColorStop(0, "#0a1230");
    bgGradient.addColorStop(0.55, "#040816");
    bgGradient.addColorStop(1, "#000005");
    bgCtx.fillStyle = bgGradient;
    bgCtx.fillRect(0, 0, 2, 256);
    const bgTexture = new THREE.CanvasTexture(bgCanvas);
    scene.background = bgTexture;
    disposablesRef.current.push(bgTexture);

    // Earth Sphere: swappable map style (night / satellite / minimal dark) + relief bump map
    const textureLoader = new THREE.TextureLoader();
    const earthGeo = new THREE.SphereGeometry(5, isMobile ? 48 : 64, isMobile ? 48 : 64);
    disposablesRef.current.push(earthGeo);

    const loadStyleTexture = (
      style: GlobeMapStyle,
      onReady: (tex: THREE.Texture) => void,
      onError?: () => void
    ) => {
      const cached = globeTexturesRef.current[style];
      if (cached) {
        onReady(cached);
        return;
      }
      textureLoader.load(
        GLOBE_MAP_TEXTURES[style],
        (texture) => {
          if (isCancelled) {
            texture.dispose();
            return;
          }
          texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
          texture.colorSpace = THREE.SRGBColorSpace;
          globeTexturesRef.current[style] = texture;
          disposablesRef.current.push(texture);
          onReady(texture);
        },
        undefined,
        () => {
          // Leave the fallback wireframe mesh in place; let the caller settle any
          // loading state so the UI doesn't wait forever on a texture that never arrives.
          if (!isCancelled) onError?.();
        }
      );
    };

    // Fallback wireframe shown until the real texture resolves (removed once it does)
    const fallbackMat = new THREE.MeshStandardMaterial({ color: 0x0c1b33, wireframe: true });
    const fallbackMesh = new THREE.Mesh(earthGeo, fallbackMat);
    scene.add(fallbackMesh);
    disposablesRef.current.push(fallbackMat);

    loadStyleTexture(mapStyle, (texture) => {
      if (isCancelled) return;
      if (fallbackMesh.parent) scene.remove(fallbackMesh);

      const earthMat = new THREE.MeshStandardMaterial({
        map: texture,
        color: mapStyle === "dots" ? DOTS_BASE_TINT : 0xffffff,
        roughness: 0.65,
        metalness: 0.15,
      });
      earthMaterialRef.current = earthMat;
      const earthMesh = new THREE.Mesh(earthGeo, earthMat);
      scene.add(earthMesh);
      disposablesRef.current.push(earthMat);
      setTextureLoaded(true);

      // Subtle surface relief from the topology map (loaded once, reused across styles)
      if (bumpTextureRef.current) {
        earthMat.bumpMap = bumpTextureRef.current;
        earthMat.bumpScale = 0.035;
        earthMat.needsUpdate = true;
      } else {
        textureLoader.load(
          "/globe/earth-topology.png",
          (bumpTex) => {
            if (isCancelled) {
              bumpTex.dispose();
              return;
            }
            bumpTextureRef.current = bumpTex;
            disposablesRef.current.push(bumpTex);
            if (earthMaterialRef.current) {
              earthMaterialRef.current.bumpMap = bumpTex;
              earthMaterialRef.current.bumpScale = 0.035;
              earthMaterialRef.current.needsUpdate = true;
            }
          },
          undefined,
          () => {}
        );
      }
    }, () => {
      // Texture failed to load: settle the loading state so the overlay clears and the
      // fallback wireframe globe (already in the scene) is shown instead of waiting forever.
      setTextureLoaded(true);
      setTextureLoadFailed(true);
    });

    // Fresnel atmosphere glow: soft cyan rim, replaces the old flat backside-sphere halo
    const atmosGeo = new THREE.SphereGeometry(5.75, isMobile ? 32 : 64, isMobile ? 32 : 64);
    const atmosMat = new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color(0x67e8f9) },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vViewPos;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          vViewPos = -mvPos.xyz;
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        uniform vec3 glowColor;
        varying vec3 vNormal;
        varying vec3 vViewPos;
        void main() {
          // Back faces: -dot is ~0.49 just outside the earth's rim and 0 at the halo's outer edge,
          // so the glow fades smoothly outward instead of drawing a hard ring.
          float d = clamp(-dot(normalize(vNormal), normalize(vViewPos)), 0.0, 1.0);
          float glow = pow(smoothstep(0.0, 0.5, d), 1.6);
          gl_FragColor = vec4(glowColor, glow * 0.32);
        }
      `,
      transparent: true,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const atmosMesh = new THREE.Mesh(atmosGeo, atmosMat);
    scene.add(atmosMesh);
    disposablesRef.current.push(atmosGeo, atmosMat);

    // Dotted style: point cloud on land (lighter on mobile). The image is the same file as the
    // dots base map, so the browser cache serves it.
    new THREE.ImageLoader().load(
      GLOBE_MAP_TEXTURES.dots,
      (image) => {
        if (isCancelled) return;
        const positions = fibonacciLandDots(isMobile ? 24000 : 60000, 5.02, landMaskFromImage(image));
        const dotsGeo = new THREE.BufferGeometry();
        dotsGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        const dotsMat = new THREE.PointsMaterial({
          color: LAND_DOT_COLOR_HEX,
          size: isMobile ? 0.09 : 0.075,
          map: spriteTexture,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
          sizeAttenuation: true,
        });
        const dots = new THREE.Points(dotsGeo, dotsMat);
        dots.visible = mapStyle === "dots";
        scene.add(dots);
        landDotsRef.current = dots;
        disposablesRef.current.push(dotsGeo, dotsMat);
      },
      undefined,
      () => {} // no dots: the tinted base map still shows the continents
    );

    // Group for dynamic 3D marker meshes
    const markersGroup = new THREE.Group();
    scene.add(markersGroup);
    markersGroupRef.current = markersGroup;

    // Group for Worldwide Remote connection arcs (populated by a separate effect)
    const arcsGroup = new THREE.Group();
    scene.add(arcsGroup);
    arcsGroupRef.current = arcsGroup;

    // Selected marker glowing ring mesh
    const selRingGeo = new THREE.RingGeometry(0.24, 0.36, 32);
    const selRingMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95,
    });
    const selRingMesh = new THREE.Mesh(selRingGeo, selRingMat);
    selRingMesh.visible = false;
    scene.add(selRingMesh);
    selectionRingRef.current = selRingMesh;
    disposablesRef.current.push(selRingGeo, selRingMat);

    // Resize Handler
    const handleResize = () => {
      if (!containerRef.current || !renderer || !camera) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    // Pause the render loop when the tab is hidden or the globe is scrolled off-screen
    let isOnScreen = true;
    const handleVisibilityChange = () => {
      if (document.hidden || !isOnScreen) {
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
      } else {
        if (!animationFrameRef.current) {
          animate();
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const onScreenObserver = new IntersectionObserver(([entry]) => {
      isOnScreen = entry.isIntersecting;
      handleVisibilityChange();
    });
    onScreenObserver.observe(container);

    // Idle spin slows while the pointer is over the globe or a city marker (stripe.com style)
    let isHovering = false;
    const hoverRoot = container.parentElement ?? container;
    const handlePointerOver = (e: PointerEvent) => {
      const t = e.target as Element | null;
      isHovering = t === renderer.domElement || Boolean(t?.closest?.(".city-marker-btn"));
    };
    const handlePointerLeave = () => {
      isHovering = false;
    };
    hoverRoot.addEventListener("pointerover", handlePointerOver);
    hoverRoot.addEventListener("pointerleave", handlePointerLeave);

    // 60 FPS Animation Loop (Zero React Re-renders)
    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate);

      // Camera flyTo transition
      if (isTransitioningRef.current && targetCameraPosRef.current) {
        camera.position.lerp(targetCameraPosRef.current, 0.075);
        controls.target.lerp(new THREE.Vector3(0, 0, 0), 0.075);
        controls.update();

        if (camera.position.distanceTo(targetCameraPosRef.current) < 0.08) {
          isTransitioningRef.current = false;
        }
      } else {
        controls.autoRotate = isSpinningRef.current && !selectedCityRef.current;
        const targetSpeed = controls.autoRotate ? (isHovering ? 0.15 : 0.75) : 0;
        controls.autoRotateSpeed += (targetSpeed - controls.autoRotateSpeed) * 0.04;
        controls.update();
      }

      // Update HTML button marker positions directly in DOM
      const data = telemetryRef.current;
      if (data && data.cities && containerRef.current) {
        const camPos = camera.position.clone().normalize();
        const cWidth = containerRef.current.clientWidth;
        const cHeight = containerRef.current.clientHeight;
        const cFilter = countryFilterRef.current;
        const rFilter = regionFilterRef.current;

        const visibleMarkers: {
          city: any;
          el: HTMLButtonElement;
          screenX: number;
          screenY: number;
          isSelected: boolean;
          edgeFade: number;
        }[] = [];

        for (let i = 0; i < data.cities.length; i++) {
          const city = data.cities[i];
          const el = markerElementsRef.current.get(city.id);
          if (!el) continue;

          const { x, y, z } = latLngToVector3(city.coordinates[1], city.coordinates[0], 5.05);
          scratchWorldPos.set(x, y, z);
          scratchMarkerDir.copy(scratchWorldPos).normalize();
          const dot = camPos.dot(scratchMarkerDir);
          const isMatch = matchesFilters(city, cFilter, rFilter);

          // Fully cull well past the horizon (saves layout cost). Nearer the horizon, or when
          // filtered out, the marker stays mounted and fades via CSS transition instead of
          // snapping with display:none, satisfying both "far-side fade" and "filters fade".
          if (dot > -0.08) {
            scratchScreenVec.copy(scratchWorldPos).project(camera);
            if (scratchScreenVec.z < 1) {
              const screenX = (scratchScreenVec.x * 0.5 + 0.5) * cWidth;
              const screenY = (-scratchScreenVec.y * 0.5 + 0.5) * cHeight;
              el.style.transform = `translate3d(${screenX}px, ${screenY}px, 0) translate(-50%, -50%)`;
              el.style.display = "flex";
              // dot in [0.15, -0.08] maps to edge fade [1, 0]; filtered-out markers fade to 0
              const edgeFade = Math.max(0, Math.min(1, (dot + 0.08) / 0.23));
              const targetOpacity = isMatch ? edgeFade : 0;
              el.style.opacity = String(targetOpacity);
              el.style.pointerEvents = targetOpacity > 0.4 ? "auto" : "none";
              if (isMatch) {
                const isSelected = selectedCityRef.current?.id === city.id;
                visibleMarkers.push({ city, el, screenX, screenY, isSelected, edgeFade });
              }
              continue;
            }
          }
          el.style.display = "none";
        }

        // Prioritize selected city and higher-count cities for badge display & cluster survival
        visibleMarkers.sort((a, b) => {
          if (a.isSelected) return -1;
          if (b.isSelected) return 1;
          return (b.city.totalCount || 0) - (a.city.totalCount || 0);
        });

        // Collision avoidance + lightweight clustering: nearby labels merge into the
        // surviving (higher-count) one; it splits back out once they're no longer close
        // (zooming in increases on-screen distance between cities).
        const placed: { x: number; y: number; badgeEl: HTMLElement; extraCount: number; extraJobs: number }[] = [];
        for (const marker of visibleMarkers) {
          const badgeEl = marker.el.querySelector(".city-tag-badge") as HTMLElement | null;
          const lineEl = marker.el.querySelector(".city-leader-line") as HTMLElement | null;
          if (!badgeEl) continue;
          if (lineEl) lineEl.style.opacity = marker.edgeFade > 0.4 ? "1" : "0";

          if (marker.isSelected) {
            badgeEl.style.opacity = "1";
            badgeEl.style.pointerEvents = "auto";
            placed.push({ x: marker.screenX, y: marker.screenY, badgeEl, extraCount: 0, extraJobs: 0 });
            continue;
          }

          let mergedInto: (typeof placed)[number] | null = null;
          for (const p of placed) {
            const dist = Math.hypot(marker.screenX - p.x, marker.screenY - p.y);
            if (dist < 55) {
              mergedInto = p;
              break;
            }
          }

          if (mergedInto) {
            // Merge into the surviving (closer in sort order = higher priority) label
            mergedInto.extraCount += 1;
            mergedInto.extraJobs += marker.city.totalCount || 0;
            badgeEl.style.opacity = "0";
            badgeEl.style.pointerEvents = "none";
          } else {
            const visible = marker.edgeFade > 0.4;
            badgeEl.style.opacity = visible ? "1" : "0";
            badgeEl.style.pointerEvents = visible ? "auto" : "none";
            placed.push({ x: marker.screenX, y: marker.screenY, badgeEl, extraCount: 0, extraJobs: 0 });
          }
        }

        // Write the "+N more (M jobs)" cluster suffix on each surviving label
        for (const p of placed) {
          const extraEl = p.badgeEl.querySelector(".cluster-extra") as HTMLElement | null;
          if (!extraEl) continue;
          if (p.extraCount > 0) {
            extraEl.textContent = `+${p.extraCount} (${p.extraJobs})`;
            extraEl.style.display = "inline";
          } else {
            extraEl.style.display = "none";
          }
        }
      }

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      isCancelled = true;
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (autoRotateResumeTimeoutRef.current) clearTimeout(autoRotateResumeTimeoutRef.current);
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      onScreenObserver.disconnect();
      hoverRoot.removeEventListener("pointerover", handlePointerOver);
      hoverRoot.removeEventListener("pointerleave", handlePointerLeave);
      landDotsRef.current = null;

      disposablesRef.current.forEach((d) => {
        try {
          d.dispose();
        } catch {}
      });
      disposablesRef.current = [];

      // Marker meshes are owned by effect 9 (telemetry/filter updates) and are
      // not in disposablesRef; dispose whatever is currently mounted.
      const markersGroup = markersGroupRef.current;
      if (markersGroup) {
        while (markersGroup.children.length > 0) {
          const child = markersGroup.children[0] as THREE.Mesh;
          if (child.geometry) child.geometry.dispose();
          if (child.material) {
            if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
            else child.material.dispose();
          }
          markersGroup.remove(child);
        }
      }

      // Arc meshes are owned by the Worldwide Remote arcs effect; dispose whatever remains.
      const arcsGroup = arcsGroupRef.current;
      if (arcsGroup) {
        while (arcsGroup.children.length > 0) {
          const child = arcsGroup.children[0] as THREE.Mesh;
          if (child.geometry) child.geometry.dispose();
          if (child.material) {
            if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
            else child.material.dispose();
          }
          arcsGroup.remove(child);
        }
      }

      controls.dispose();
      renderer.dispose();
      // renderer.dispose() frees GPU resources but keeps the WebGL context
      // alive; browsers cap live contexts (~16), so release it explicitly on
      // unmount to avoid context exhaustion across mount/unmount cycles.
      if (typeof renderer.forceContextLoss === "function") {
        renderer.forceContextLoss();
      }
      if (renderer.domElement) {
        renderer.domElement.remove();
      }
    };
  }, [webglSupported]);

  // 9. Update 3D WebGL marker meshes when telemetry or filter changes
  useEffect(() => {
    const group = markersGroupRef.current;
    if (!group || !telemetry) return;

    while (group.children.length > 0) {
      const child = group.children[0] as THREE.Mesh;
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
      group.remove(child);
    }

    telemetry.cities.forEach((city) => {
      const isVisible = matchesFilters(city, countryFilter, regionFilter);
      const { x, y, z } = latLngToVector3(city.coordinates[1], city.coordinates[0], 5.02);
      const markerVec = new THREE.Vector3(x, y, z);
      const radius = getMarkerRadius(city.totalCount);

      // Single teal/cyan marker color; size (not hue) communicates job count
      const diodeGeo = new THREE.SphereGeometry(radius * 0.7, 16, 16);
      const diodeMat = new THREE.MeshBasicMaterial({
        color: MARKER_COLOR_HEX,
        transparent: true,
        opacity: isVisible ? 0.95 : 0,
      });
      const diode = new THREE.Mesh(diodeGeo, diodeMat);
      diode.position.copy(markerVec);
      group.add(diode);

      const ringGeo = new THREE.RingGeometry(radius * 1.1, radius * 1.8, 24);
      const ringMat = new THREE.MeshBasicMaterial({
        color: MARKER_COLOR_HEX,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: isVisible ? 0.3 : 0,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.copy(markerVec);
      ring.lookAt(markerVec.clone().multiplyScalar(2));
      group.add(ring);
    });
  }, [telemetry, countryFilter, regionFilter]);

  // 10. Update Selection Ring Mesh in 3D scene
  useEffect(() => {
    const selRing = selectionRingRef.current;
    if (!selRing) return;

    if (selectedCity && selectedCity.coordinates) {
      const { x, y, z } = latLngToVector3(
        selectedCity.coordinates[1],
        selectedCity.coordinates[0],
        5.06
      );
      const markerVec = new THREE.Vector3(x, y, z);
      selRing.position.copy(markerVec);
      selRing.lookAt(markerVec.clone().multiplyScalar(2));
      selRing.visible = true;
    } else {
      selRing.visible = false;
    }
  }, [selectedCity]);

  // Handle City Select (Cinematic flyTo)
  const handleCitySelect = useCallback((city: ActiveSelection) => {
    setRadarProUnlockError(false);
    setSelectedCity(city);
    setIsSpinning(false);

    if (!cameraRef.current || !controlsRef.current || !city.coordinates) return;

    const { x, y, z } = latLngToVector3(city.coordinates[1], city.coordinates[0], 5);
    const cityVec = new THREE.Vector3(x, y, z);

    const isMobile = window.innerWidth < 640;
    const zoomScalar = isMobile ? 9.8 : 8.2;
    const cameraTarget = cityVec.clone().normalize().multiplyScalar(zoomScalar);

    targetCameraPosRef.current = cameraTarget;
    targetLookAtRef.current = new THREE.Vector3(0, 0, 0);
    isTransitioningRef.current = true;
  }, []);

  // Handle Close Drawer
  const handleCloseDrawer = useCallback(() => {
    setRadarProUnlockError(false);
    setSelectedCity(null);
    if (!cameraRef.current || !controlsRef.current) return;

    const isMobile = window.innerWidth < 640;
    const currentDir = cameraRef.current.position.clone().normalize();
    targetCameraPosRef.current = currentDir.multiplyScalar(isMobile ? 16.5 : 13.8);
    targetLookAtRef.current = new THREE.Vector3(0, 0, 0);
    isTransitioningRef.current = true;
    setIsSpinning(true);
  }, []);

  // Handle Region Pills
  const handleRegionPillClick = (regionId: string) => {
    setRegionFilter(regionId);
    setCountryFilter("all");
    setSelectedCity(null);
    updateUrlFilters({ country: "all" });

    if (!cameraRef.current || !controlsRef.current) return;

    const region = RADAR_REGIONS.find((r) => r.id === regionId);
    if (!region || region.id === "all") {
      setIsSpinning(true);
      const isMobile = window.innerWidth < 640;
      targetCameraPosRef.current = new THREE.Vector3(0, isMobile ? 1.8 : 4.8, isMobile ? 18 : 17);
      targetLookAtRef.current = new THREE.Vector3(0, 0, 0);
      isTransitioningRef.current = true;
    } else {
      setIsSpinning(false);
      const { x, y, z } = latLngToVector3(region.center[1], region.center[0], 5);
      const countryVec = new THREE.Vector3(x, y, z);
      const targetPos = countryVec.clone().normalize().multiplyScalar(10.5);

      targetCameraPosRef.current = targetPos;
      targetLookAtRef.current = new THREE.Vector3(0, 0, 0);
      isTransitioningRef.current = true;
    }
  };

  // Handle Specific Country Filter Change
  const handleCountryFilterChange = (isoCode: string) => {
    setCountryFilter(isoCode);
    updateUrlFilters({ country: isoCode });
    setSelectedCity(null);

    if (isoCode === "all") {
      handleRegionPillClick("all");
      return;
    }

    if (!cameraRef.current || !controlsRef.current || !telemetry) return;
    const countryData = telemetry.countries[isoCode];
    if (countryData && countryData.coordinates) {
      setIsSpinning(false);
      const { x, y, z } = latLngToVector3(
        countryData.coordinates[1],
        countryData.coordinates[0],
        5
      );
      const countryVec = new THREE.Vector3(x, y, z);
      const targetPos = countryVec.clone().normalize().multiplyScalar(10.2);

      targetCameraPosRef.current = targetPos;
      targetLookAtRef.current = new THREE.Vector3(0, 0, 0);
      isTransitioningRef.current = true;
    }
  };

  // Dedicated Worldwide Remote Click
  const handleWorldwideRemoteClick = () => {
    setRadarProUnlockError(false);
    if (!telemetry) return;
    setSelectedCity({
      id: "worldwide-remote",
      name: "Worldwide Remote",
      countryCode: "GLOBAL",
      totalCount: telemetry.worldwideRemote.totalCount,
      verifiedCount: telemetry.worldwideRemote.verifiedCount,
      isWorldwideRemote: true,
    });
  };

  // Reset Orbit
  const handleResetOrbit = () => {
    setSelectedCity(null);
    setRegionFilter("all");
    setIsSpinning(true);

    if (!cameraRef.current || !controlsRef.current) return;
    const isMobile = window.innerWidth < 640;
    targetCameraPosRef.current = new THREE.Vector3(0, isMobile ? 1.8 : 4.8, isMobile ? 18 : 17);
    targetLookAtRef.current = new THREE.Vector3(0, 0, 0);
    isTransitioningRef.current = true;
  };

  const handleApplyClick = (jobId: string) => {
    setAppliedJobs((prev) => ({ ...prev, [jobId]: true }));
  };

  // Keyboard controls: arrows rotate, +/- zoom, Esc closes the drawer
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      if (e.key === "Escape") {
        if (selectedCityRef.current) {
          e.preventDefault();
          handleCloseDrawer();
        }
        return;
      }

      const controls = controlsRef.current;
      const camera = cameraRef.current;
      if (!controls || !camera) return;

      const rotateStep = 0.08;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          camera.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotateStep);
          controls.update();
          break;
        case "ArrowRight":
          e.preventDefault();
          camera.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), -rotateStep);
          controls.update();
          break;
        case "ArrowUp": {
          e.preventDefault();
          const axis = new THREE.Vector3().crossVectors(camera.position, new THREE.Vector3(0, 1, 0)).normalize();
          camera.position.applyAxisAngle(axis, rotateStep);
          controls.update();
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          const axis = new THREE.Vector3().crossVectors(camera.position, new THREE.Vector3(0, 1, 0)).normalize();
          camera.position.applyAxisAngle(axis, -rotateStep);
          controls.update();
          break;
        }
        case "+":
        case "=": {
          e.preventDefault();
          const dir = camera.position.clone().normalize();
          const newDist = Math.max(controls.minDistance, camera.position.length() - 0.8);
          camera.position.copy(dir.multiplyScalar(newDist));
          controls.update();
          break;
        }
        case "-":
        case "_": {
          e.preventDefault();
          const dir = camera.position.clone().normalize();
          const newDist = Math.min(controls.maxDistance, camera.position.length() + 0.8);
          camera.position.copy(dir.multiplyScalar(newDist));
          controls.update();
          break;
        }
        default:
          return;
      }
      setIsSpinning(false);
      dismissNavHint();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleCloseDrawer, dismissNavHint]);

  // Compute Explore All URL carrying all 4 Light Filters
  const exploreAllUrl = useMemo(() => {
    if (!selectedCity) return "/job-search/all";
    const p = new URLSearchParams();
    if (selectedCity.isWorldwideRemote) {
      p.set("remote", "true");
    } else {
      p.set("city", selectedCity.name);
    }
    if (countryFilter !== "all") p.set("country", countryFilter);
    if (categoryFilter !== "all") p.set("cat", categoryFilter);
    if (remoteFilter) p.set("remote", "true");
    if (internshipFilter) p.set("internship", "true");
    return `/job-search/all?${p.toString()}`;
  }, [selectedCity, countryFilter, categoryFilter, remoteFilter, internshipFilter]);

  // Telemetry numbers
  const activeCountDisplay = telemetry?.header?.totalActive != null ? telemetry.header.totalActive.toLocaleString() : "...";
  const verifiedCountDisplay = telemetry?.header?.totalVerified != null ? telemetry.header.totalVerified.toLocaleString() : "...";

  // List of real countries sorted by job count
  const realCountriesList = useMemo(() => {
    if (!telemetry || !telemetry.countries) return [];
    return Object.entries(telemetry.countries)
      .map(([code, data]) => ({
        code,
        name: data.name,
        total: data.total,
      }))
      .sort((a, b) => b.total - a.total);
  }, [telemetry]);

  return (
    <div className="relative w-full flex-1 h-full min-h-[580px] bg-[#040610] text-white overflow-hidden select-none font-sans">
      {/* 3D WebGL Canvas Container */}
      {webglSupported ? (
        <div
          ref={containerRef}
          onClick={() => {
            if (selectedCity) handleCloseDrawer();
          }}
          className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing"
        />
      ) : (
        /* Accessible No-WebGL Fallback UI */
        <div className="absolute inset-0 z-10 overflow-y-auto p-6 flex flex-col items-center justify-center bg-slate-950/95 text-center">
          <div className="max-w-xl p-8 rounded-2xl bg-slate-900/80 border border-cyan-500/30 backdrop-blur-xl">
            <Globe2 className="w-12 h-12 text-cyan-400 mx-auto mb-4 animate-pulse" />
            <h2 className="text-2xl font-bold text-white mb-2">Live Job Radar Orbit</h2>
            <p className="text-slate-300 text-sm mb-6">
              WebGL is not enabled on your browser. Browse real verified tech hubs directly below:
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-64 overflow-y-auto p-2">
              {telemetry?.cities.map((city) => (
                <Link
                  key={city.id}
                  href={`/job-search/all?city=${encodeURIComponent(city.name)}`}
                  className="p-2.5 rounded-lg bg-slate-800/60 hover:bg-cyan-950/60 border border-slate-700/60 text-left transition-all"
                >
                  <p className="text-xs font-bold text-white truncate">{city.name}</p>
                  <p className="text-[11px] text-cyan-400 font-mono mt-0.5">
                    {city.totalCount} active jobs
                  </p>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Cyber Radial Overlay */}
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-transparent via-slate-950/10 to-slate-950/75" />

      {/* Loading Skeleton: shown until the globe texture and telemetry are both ready */}
      {webglSupported && (!textureLoaded || (isLoadingTelemetry && !telemetry)) && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#040610] pointer-events-none">
          <div className="flex flex-col items-center gap-4">
            <div
              className={`w-40 h-40 sm:w-56 sm:h-56 rounded-full bg-gradient-to-br from-slate-800 to-slate-900 border border-slate-700/60 ${
                prefersReducedMotion ? "" : "animate-pulse"
              }`}
            />
            <div className="flex items-center gap-2 text-xs font-mono text-cyan-400/80">
              <Loader2 className={`w-3.5 h-3.5 ${prefersReducedMotion ? "" : "animate-spin"}`} />
              <span>Loading live radar telemetry…</span>
            </div>
          </div>
        </div>
      )}

      {telemetryError && !telemetry && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#040610]">
          <div className="max-w-sm p-6 rounded-2xl bg-slate-900/80 border border-red-500/30 text-center space-y-3">
            <AlertCircle className="w-8 h-8 text-red-400 mx-auto" />
            <p className="text-sm text-slate-300">{telemetryError}</p>
            <button
              type="button"
              onClick={() => fetchTelemetry()}
              className="px-4 py-2 rounded-full text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-white border border-slate-600 transition cursor-pointer"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Small non-blocking note: the globe texture itself failed to load (city data and
          interactions still work normally against the plain wireframe fallback globe). */}
      {textureLoadFailed && (
        <div className="absolute top-36 sm:top-28 right-3 z-30 pointer-events-none flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-950/85 border border-amber-500/30 backdrop-blur-md text-[11px] text-amber-300 shadow-lg">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>Globe imagery failed to load — showing wireframe view</span>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 3D PROJECTED HTML CITY MARKERS (Zero React Re-render Animation Loop)      */}
      {/* ========================================================================= */}
      {webglSupported && telemetry && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
          {telemetry.cities.map((city) => {
            const isSelected = selectedCity?.id === city.id;

            return (
              <button
                key={city.id}
                ref={(el) => {
                  if (el) markerElementsRef.current.set(city.id, el);
                  else markerElementsRef.current.delete(city.id);
                }}
                type="button"
                aria-label={`View ${city.totalCount} active jobs in ${city.name}`}
                style={{
                  display: "none",
                  position: "absolute",
                  left: 0,
                  top: 0,
                }}
                className="city-marker-btn pointer-events-auto flex flex-col items-center cursor-pointer group transition-[transform,opacity] duration-300 hover:scale-115 focus:outline-none"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCitySelect(city);
                }}
                onMouseEnter={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const parentRect = containerRef.current?.getBoundingClientRect();
                  setHoveredCity(city);
                  setHoveredPos({
                    x: rect.left + rect.width / 2 - (parentRect?.left || 0),
                    y: rect.top - (parentRect?.top || 0),
                  });
                }}
                onMouseLeave={() => {
                  setHoveredCity((prev) => (prev?.id === city.id ? null : prev));
                  setHoveredPos(null);
                }}
              >
                {/* Concentric Radar Ping Rings (disabled under prefers-reduced-motion) */}
                {!prefersReducedMotion && (
                  <>
                    <div
                      className="absolute -top-3.5 -left-3.5 w-11 h-11 rounded-full animate-radar-ping pointer-events-none opacity-40"
                      style={{ backgroundColor: MARKER_COLOR_CSS }}
                    />
                    <div
                      className="absolute -top-3.5 -left-3.5 w-11 h-11 rounded-full animate-radar-ping-delay pointer-events-none opacity-30"
                      style={{ backgroundColor: MARKER_COLOR_CSS }}
                    />
                  </>
                )}

                {/* Core Diode with Selected Glowing Ring */}
                <div
                  className={`relative w-4 h-4 rounded-full border-2 flex items-center justify-center transition-all ${
                    isSelected
                      ? "ring-4 ring-white ring-offset-2 ring-offset-slate-950 scale-130 border-white shadow-[0_0_20px_#ffffff]"
                      : "border-white/80 group-hover:scale-115"
                  }`}
                  style={{
                    backgroundColor: MARKER_COLOR_CSS,
                    boxShadow: isSelected ? "0 0 20px #ffffff" : `0 0 12px ${MARKER_GLOW_CSS}`,
                  }}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-white" />
                </div>

                {/* Leader line connecting the dot to its label pill */}
                <div className="city-leader-line w-px h-2 bg-cyan-300/40 transition-opacity duration-200" />

                {/* City Tag Badge (glass pill) */}
                <div
                  className={`city-tag-badge px-2.5 py-0.5 rounded-full border text-[11px] font-semibold shadow-[0_4px_14px_rgba(0,0,0,0.85)] backdrop-blur-md flex items-center gap-1.5 whitespace-nowrap transition-opacity duration-200 group-hover:opacity-100! group-hover:pointer-events-auto! ${
                    isSelected
                      ? "bg-slate-950/80 border-white text-white ring-2 ring-white/50"
                      : "bg-slate-950/70 border-slate-700/80 text-slate-200 group-hover:border-cyan-400 group-hover:text-white"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${prefersReducedMotion ? "" : "animate-pulse"}`}
                    style={{ backgroundColor: MARKER_COLOR_CSS }}
                  />
                  <span>{city.name}</span>
                  <span className="font-mono font-normal opacity-85" style={{ color: MARKER_COLOR_CSS }}>
                    ({city.totalCount})
                  </span>
                  <span className="cluster-extra font-mono font-normal text-slate-400" style={{ display: "none" }} />
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Hover Tooltip: city, job count, verified count, top companies */}
      {hoveredCity && hoveredPos && (
        <div
          className="absolute z-40 pointer-events-none -translate-x-1/2 px-3.5 py-2.5 rounded-xl bg-slate-950/95 border border-cyan-500/40 backdrop-blur-xl shadow-2xl text-xs text-slate-200 min-w-[180px] animate-fadeIn"
          style={{ left: hoveredPos.x, top: hoveredPos.y - 14, transform: "translate(-50%, -100%)" }}
        >
          <p className="font-bold text-white text-sm">{hoveredCity.name}</p>
          <div className="flex items-center gap-3 mt-1 text-[11px]">
            <span className="text-cyan-300 font-semibold">{hoveredCity.totalCount.toLocaleString()} jobs</span>
            <span className="text-emerald-400 font-semibold flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" /> {hoveredCity.verifiedCount.toLocaleString()} verified
            </span>
          </div>
          {hoveredCity.topCompanies && hoveredCity.topCompanies.length > 0 && (
            <p className="mt-1.5 text-[10px] text-slate-400 truncate">
              Top companies: {hoveredCity.topCompanies.slice(0, 3).join(", ")}
            </p>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TOP FLOATING CONTROLS: Row 1 (Telemetry & Regions) + Row 2 (4 Light Filters) */}
      {/* ========================================================================= */}
      <div className="absolute top-3 left-0 right-0 z-30 flex flex-col gap-2 px-3 sm:px-6 pointer-events-none">
        {/* Row 1: Telemetry Badge, Region Pills, Orbit Controls */}
        <div className="flex flex-col md:flex-row items-center justify-between gap-2">
          {/* Left: Telemetry Live Status Badge */}
          <div className="pointer-events-auto flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-950/85 border border-cyan-500/30 backdrop-blur-md shadow-lg shadow-cyan-950/30 text-xs">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
            </span>
            <div className="flex items-center gap-1.5 font-semibold text-cyan-200">
              <Radio className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
              <span className="uppercase font-mono tracking-wider">RADAR</span>
              <span className="text-slate-500">•</span>
              <span className="text-slate-200 font-bold">{activeCountDisplay}</span>
              <span className="text-slate-400 font-normal hidden sm:inline">Active Direct Jobs</span>
              <span className="text-slate-500 hidden sm:inline">•</span>
              <span className="text-emerald-400 font-semibold hidden sm:inline">
                {verifiedCountDisplay} Verified
              </span>
            </div>
          </div>

          {/* Center: Region Pills & Worldwide Remote */}
          <div className="pointer-events-auto flex items-center gap-1 p-1 rounded-full bg-slate-950/85 border border-slate-700/60 backdrop-blur-md shadow-xl max-w-full overflow-x-auto no-scrollbar">
            {RADAR_REGIONS.map((region) => {
              const isActive =
                regionFilter === region.id &&
                countryFilter === "all" &&
                !selectedCity?.isWorldwideRemote;
              return (
                <button
                  key={region.id}
                  type="button"
                  onClick={() => handleRegionPillClick(region.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 min-h-[38px] rounded-full text-xs font-semibold transition-all duration-200 whitespace-nowrap ${
                    isActive
                      ? "bg-cyan-500 text-slate-950 shadow-[0_0_15px_rgba(6,182,212,0.5)] font-bold scale-102"
                      : "text-slate-300 hover:text-white hover:bg-slate-800/60"
                  }`}
                >
                  <span>{region.flag}</span>
                  <span>{region.label}</span>
                </button>
              );
            })}

            {/* Dedicated Worldwide Remote Button */}
            {telemetry && (
              <button
                type="button"
                onClick={handleWorldwideRemoteClick}
                title="View all Worldwide Remote roles"
                className={`flex items-center gap-1.5 px-3 py-1.5 min-h-[38px] rounded-full text-xs font-semibold transition-all duration-200 whitespace-nowrap border ${
                  selectedCity?.isWorldwideRemote
                    ? "bg-emerald-500 text-slate-950 border-emerald-400 font-bold shadow-[0_0_15px_rgba(16,185,129,0.5)]"
                    : "bg-emerald-950/40 border-emerald-500/30 text-emerald-300 hover:bg-emerald-900/50"
                }`}
              >
                <Globe2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Worldwide Remote ({telemetry.worldwideRemote.totalCount.toLocaleString()})</span>
              </button>
            )}
          </div>

          {/* Right: Quick Controls */}
          <div className="pointer-events-auto flex items-center gap-2">
            {/* Reset Orbit */}
            <button
              type="button"
              onClick={handleResetOrbit}
              title="Reset to Global Orbit"
              className="flex items-center gap-1.5 px-3 py-1.5 min-h-[38px] rounded-full bg-slate-950/80 border border-slate-700 text-xs font-medium text-slate-200 hover:text-white hover:border-cyan-400 transition-all backdrop-blur-md"
            >
              <RotateCw className="w-3.5 h-3.5 text-cyan-400" />
              <span className="hidden sm:inline">Orbit</span>
            </button>

            {/* Auto-Spin Toggle */}
            <button
              type="button"
              onClick={() => setIsSpinning((prev) => !prev)}
              title={isSpinning ? "Pause Auto-Rotation" : "Resume Auto-Rotation"}
              className={`p-2 min-w-[38px] min-h-[38px] flex items-center justify-center rounded-full border text-xs font-medium transition-all backdrop-blur-md ${
                isSpinning
                  ? "bg-cyan-950/60 border-cyan-500/50 text-cyan-300"
                  : "bg-slate-950/80 border-slate-700 text-slate-400 hover:text-white"
              }`}
            >
              <Compass
                className={`w-4 h-4 ${isSpinning ? "animate-spin text-cyan-400" : ""}`}
                style={{ animationDuration: "14s" }}
              />
            </button>

            {/* Layers Toggle: night / satellite / minimal dark map style */}
            <button
              type="button"
              onClick={() => setShowLayersPanel((prev) => !prev)}
              title="Switch map style (Night / Satellite / Minimal Dark)"
              aria-label="Switch map style"
              aria-expanded={showLayersPanel}
              className={`p-2 min-w-[38px] min-h-[38px] flex items-center justify-center rounded-full border text-xs font-medium transition-all backdrop-blur-md ${
                showLayersPanel
                  ? "bg-cyan-950/80 border-cyan-500 text-cyan-300"
                  : "bg-slate-950/80 border-slate-700 text-slate-400 hover:text-white"
              }`}
            >
              <Layers className="w-4 h-4 text-cyan-400" />
            </button>
          </div>
        </div>

        {/* ===================================================================== */}
        {/* Row 2 (desktop/tablet): THE 4 LIGHT FILTERS, inline glass toolbar     */}
        {/* ===================================================================== */}
        <div className="pointer-events-auto hidden sm:flex items-center justify-center gap-1.5 p-1.5 rounded-2xl bg-slate-950/90 border border-slate-800/90 backdrop-blur-xl shadow-2xl max-w-full overflow-x-auto no-scrollbar mx-auto px-2">
          {/* Filter 1: Real Countries Dropdown */}
          <div className="relative flex items-center shrink-0">
            <select
              value={countryFilter}
              onChange={(e) => handleCountryFilterChange(e.target.value)}
              aria-label="Filter by Country"
              className="appearance-none bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-700/80 hover:border-cyan-500/60 rounded-xl px-3 py-2 pr-7 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-cyan-400 transition-all cursor-pointer min-h-[44px]"
            >
              <option value="all">🌍 All Countries</option>
              {realCountriesList.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name} ({c.total})
                </option>
              ))}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-2 pointer-events-none" />
          </div>

          {/* Filter 2: Category Dropdown */}
          <div className="relative flex items-center shrink-0">
            <select
              value={categoryFilter}
              onChange={(e) => {
                setCategoryFilter(e.target.value);
                updateUrlFilters({ cat: e.target.value });
              }}
              aria-label="Filter by Category"
              className="appearance-none bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-700/80 hover:border-cyan-500/60 rounded-xl px-3 py-2 pr-7 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-cyan-400 transition-all cursor-pointer min-h-[44px]"
            >
              <option value="all">💼 All Categories</option>
              {CANONICAL_CATEGORIES.map((cat) => (
                <option key={cat.slug} value={cat.slug}>
                  {cat.name}
                </option>
              ))}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-2 pointer-events-none" />
          </div>

          {/* Filter 3: Remote Toggle */}
          <button
            type="button"
            onClick={() => {
              const next = !remoteFilter;
              setRemoteFilter(next);
              updateUrlFilters({ remote: next });
            }}
            className={`shrink-0 flex items-center gap-1.5 px-3 py-2 min-h-[44px] rounded-xl text-xs font-semibold transition-all border ${
              remoteFilter
                ? "bg-[#2563EB] text-white border-[#2563EB] shadow-[0_0_12px_rgba(37,99,235,0.4)]"
                : "bg-slate-900 hover:bg-slate-800 text-slate-300 border-slate-700/80 hover:border-slate-600"
            }`}
          >
            <Globe2 className="w-3.5 h-3.5" />
            <span>Remote</span>
          </button>

          {/* Filter 4: Internships Toggle */}
          <button
            type="button"
            onClick={() => {
              const next = !internshipFilter;
              setInternshipFilter(next);
              updateUrlFilters({ internship: next });
            }}
            className={`shrink-0 flex items-center gap-1.5 px-3 py-2 min-h-[44px] rounded-xl text-xs font-semibold transition-all border ${
              internshipFilter
                ? "bg-[#2563EB] text-white border-[#2563EB] shadow-[0_0_12px_rgba(37,99,235,0.4)]"
                : "bg-slate-900 hover:bg-slate-800 text-slate-300 border-slate-700/80 hover:border-slate-600"
            }`}
          >
            <GraduationCap className="w-3.5 h-3.5" />
            <span>Internships</span>
          </button>

          {/* Verified Only Filter Toggle */}
          <button
            type="button"
            onClick={() => setVerifiedOnly((prev) => !prev)}
            title="Toggle Verified roles only"
            className={`shrink-0 flex items-center gap-1.5 px-3 py-2 min-h-[44px] rounded-xl text-xs font-semibold transition-all border ${
              verifiedOnly
                ? "bg-emerald-950/80 border-emerald-400 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.3)]"
                : "bg-slate-900 hover:bg-slate-800 text-slate-300 border-slate-700/80"
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden sm:inline">Verified Only</span>
          </button>

          {/* Reset All Filters Button */}
          {hasActiveFilters && (
            <button
              type="button"
              onClick={handleResetAllFilters}
              title="Reset all 4 filters"
              className="shrink-0 flex items-center gap-1 px-3 py-2 min-h-[44px] rounded-xl bg-slate-800 hover:bg-red-950/60 text-slate-300 hover:text-red-300 border border-slate-700 hover:border-red-500/50 text-xs font-medium transition-all"
            >
              <RotateCcw className="w-3 h-3 text-red-400" />
              <span>Reset</span>
            </button>
          )}
        </div>

        {/* Row 2 (mobile): single Filters button opening a bottom sheet */}
        <button
          type="button"
          onClick={() => setShowMobileFilterSheet(true)}
          className={`pointer-events-auto sm:hidden mx-auto flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-full text-xs font-semibold transition-all border ${
            hasActiveFilters
              ? "bg-cyan-950/80 border-cyan-500 text-cyan-300"
              : "bg-slate-950/90 border-slate-700/80 text-slate-200"
          }`}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          <span>Filters</span>
          {hasActiveFilters && <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />}
        </button>
      </div>

      {/* Mobile Filters Bottom Sheet */}
      {showMobileFilterSheet && (
        <div
          className="fixed inset-0 z-50 sm:hidden flex items-end bg-slate-950/70 backdrop-blur-sm"
          onClick={() => setShowMobileFilterSheet(false)}
        >
          <div
            className="w-full max-h-[75dvh] overflow-y-auto rounded-t-3xl bg-slate-950 border-t border-slate-800 p-4 pb-[env(safe-area-inset-bottom,1.25rem)] space-y-3 animate-slideUp"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                <Filter className="w-4 h-4 text-cyan-400" /> Filters
              </h3>
              <button
                type="button"
                onClick={() => setShowMobileFilterSheet(false)}
                aria-label="Close filters"
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full bg-slate-800 text-slate-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="relative">
              <select
                value={countryFilter}
                onChange={(e) => handleCountryFilterChange(e.target.value)}
                aria-label="Filter by Country (mobile)"
                className="w-full appearance-none bg-slate-900 text-slate-200 border border-slate-700/80 rounded-xl px-3 py-3 pr-8 text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-cyan-400 min-h-[44px]"
              >
                <option value="all">🌍 All Countries</option>
                {realCountriesList.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name} ({c.total})
                  </option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>

            <div className="relative">
              <select
                value={categoryFilter}
                onChange={(e) => {
                  setCategoryFilter(e.target.value);
                  updateUrlFilters({ cat: e.target.value });
                }}
                aria-label="Filter by Category (mobile)"
                className="w-full appearance-none bg-slate-900 text-slate-200 border border-slate-700/80 rounded-xl px-3 py-3 pr-8 text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-cyan-400 min-h-[44px]"
              >
                <option value="all">💼 All Categories</option>
                {CANONICAL_CATEGORIES.map((cat) => (
                  <option key={cat.slug} value={cat.slug}>
                    {cat.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  const next = !remoteFilter;
                  setRemoteFilter(next);
                  updateUrlFilters({ remote: next });
                }}
                className={`flex items-center justify-center gap-1.5 px-3 py-3 min-h-[44px] rounded-xl text-sm font-semibold border ${
                  remoteFilter ? "bg-[#2563EB] text-white border-[#2563EB]" : "bg-slate-900 text-slate-300 border-slate-700/80"
                }`}
              >
                <Globe2 className="w-4 h-4" /> Remote
              </button>
              <button
                type="button"
                onClick={() => {
                  const next = !internshipFilter;
                  setInternshipFilter(next);
                  updateUrlFilters({ internship: next });
                }}
                className={`flex items-center justify-center gap-1.5 px-3 py-3 min-h-[44px] rounded-xl text-sm font-semibold border ${
                  internshipFilter ? "bg-[#2563EB] text-white border-[#2563EB]" : "bg-slate-900 text-slate-300 border-slate-700/80"
                }`}
              >
                <GraduationCap className="w-4 h-4" /> Internships
              </button>
            </div>

            <button
              type="button"
              onClick={() => setVerifiedOnly((prev) => !prev)}
              className={`w-full flex items-center justify-center gap-1.5 px-3 py-3 min-h-[44px] rounded-xl text-sm font-semibold border ${
                verifiedOnly ? "bg-emerald-950/80 border-emerald-400 text-emerald-300" : "bg-slate-900 text-slate-300 border-slate-700/80"
              }`}
            >
              <ShieldCheck className="w-4 h-4 text-emerald-400" /> Verified Only
            </button>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={() => {
                  handleResetAllFilters();
                  setShowMobileFilterSheet(false);
                }}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-3 min-h-[44px] rounded-xl bg-slate-800 text-slate-300 border border-slate-700 text-sm font-medium"
              >
                <RotateCcw className="w-3.5 h-3.5 text-red-400" /> Reset all filters
              </button>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* POP-OUT JOB CARDS DRAWER / HUD (Real Supabase Jobs + Free vs Pro Gating)  */}
      {/* ========================================================================= */}
      {/* ========================================================================= */}
      {/* SLIDE-OVER / BOTTOM-SHEET JOB DRAWER                                      */}
      {/* ========================================================================= */}
      {selectedCity && (
        <div className="fixed inset-x-0 bottom-0 sm:absolute sm:inset-x-auto sm:bottom-6 sm:left-auto sm:right-6 sm:w-[480px] z-40 max-h-[72dvh] sm:max-h-[78vh] flex flex-col rounded-t-3xl sm:rounded-2xl bg-slate-950/95 border-t sm:border border-cyan-500/40 backdrop-blur-2xl shadow-[0_-12px_45px_rgba(0,0,0,0.85)] sm:shadow-[0_12px_50px_rgba(6,182,212,0.3)] animate-slideUp sm:animate-slideInRight overflow-hidden pb-[env(safe-area-inset-bottom,1.5rem)] sm:pb-0">
          {/* Mobile Drag Indicator Handle (tap or drag to close) */}
          <div
            onClick={handleCloseDrawer}
            className="w-full flex items-center justify-center pt-2.5 pb-1 sm:hidden bg-slate-900/95 cursor-pointer touch-none"
            aria-label="Tap to close drawer"
          >
            <div className="w-10 h-1.5 rounded-full bg-slate-500/80" />
          </div>

          {/* Drawer Header */}
          <div className="p-4 bg-gradient-to-r from-slate-900/95 to-cyan-950/60 border-b border-cyan-500/25 flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                <span className="text-[10px] font-mono uppercase tracking-wider text-cyan-400">
                  {selectedCity.isWorldwideRemote
                    ? "GLOBAL TELEMETRY • UNRESTRICTED"
                    : `RADAR LOCKED • ${selectedCity.countryCode.toUpperCase()}`}
                </span>
                {!isPro && (
                  <span className="px-2 py-0.5 rounded-full bg-[#2563EB]/20 border border-[#2563EB]/40 text-[#60A5FA] text-[10px] font-bold flex items-center gap-1">
                    <Lock className="w-2.5 h-2.5" /> Free View
                  </span>
                )}
              </div>
              <h3 className="text-lg sm:text-xl font-black text-white tracking-tight flex items-center gap-2 mt-0.5">
                {selectedCity.isWorldwideRemote ? (
                  <Globe2 className="w-5 h-5 text-emerald-400" />
                ) : (
                  <MapPin className="w-5 h-5 text-cyan-400" />
                )}
                {selectedCity.name}
              </h3>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300 mt-1">
                {selectedCity.coordinates && (
                  <>
                    <span className="font-mono text-cyan-300/80 text-[11px]">
                      {selectedCity.coordinates[1].toFixed(2)}°, {selectedCity.coordinates[0].toFixed(2)}°
                    </span>
                    <span>•</span>
                  </>
                )}
                <span className="font-semibold text-emerald-400">
                  {(jobsTotal > 0 ? jobsTotal : selectedCity.totalCount).toLocaleString()} Active
                </span>
                <span>•</span>
                <span className="text-slate-400 font-medium">
                  {(jobsTotal > 0 ? jobsTotal : selectedCity.verifiedCount).toLocaleString()} Verified
                </span>
              </div>
            </div>

            {/* Close / Orbit Actions */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCloseDrawer}
                title="Back to Global Orbit"
                className="flex items-center justify-center gap-1.5 px-3 py-1.5 min-h-[44px] rounded-full bg-slate-800/90 hover:bg-cyan-950 text-xs font-semibold text-cyan-300 hover:text-white transition-all border border-cyan-500/30 cursor-pointer shadow-xs"
              >
                <RotateCw className="w-3.5 h-3.5 text-cyan-400" />
                <span>Orbit</span>
              </button>
              <button
                type="button"
                onClick={handleCloseDrawer}
                aria-label="Close job drawer"
                className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors border border-slate-600/50 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Job Cards List (Scrollable) */}
          <div className="p-4 overflow-y-auto max-h-[52vh] space-y-3.5 divide-y divide-slate-800/60">
            {radarProUnlockError && (
              <div
                data-testid="radar-pro-unlock-error-banner"
              role="alert"
                className="p-3 rounded-xl bg-slate-900/90 border border-slate-700/80 flex items-center justify-between gap-3 text-xs text-slate-300"
              >
                <div className="flex items-center gap-2">
                  <Lock className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>Details are locked. Retry</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setRadarProUnlockError(false);
                    if (selectedCity) fetchCityJobs(selectedCity, jobsPage, false);
                  }}
                  disabled={jobsLoading}
                  className="px-3 py-1 rounded-full text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-white border border-slate-600 transition flex items-center gap-1.5 cursor-pointer"
                >
                  <RotateCw className={`w-3 h-3 ${jobsLoading ? "animate-spin" : ""}`} />
                  <span>Retry</span>
                </button>
              </div>
            )}
            {jobsLoading && drawerJobs.length === 0 ? (
              /* Loading Skeletons */
              <div className="space-y-3 py-6">
                {[1, 2, 3].map((n) => (
                  <div key={n} className="p-3 rounded-xl bg-slate-900/60 border border-slate-800/60 animate-pulse space-y-2.5">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-slate-800" />
                      <div className="space-y-1.5 flex-1">
                        <div className="h-4 bg-slate-800 rounded w-3/4" />
                        <div className="h-3 bg-slate-800/70 rounded w-1/2" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : drawerJobs.length === 0 ? (
              /* Empty State */
              <div className="py-12 text-center space-y-3">
                <AlertCircle className="w-8 h-8 text-slate-500 mx-auto" />
                <p className="text-sm font-semibold text-slate-300">
                  No active openings match the current filter
                </p>
                <p className="text-xs text-slate-500">
                  {hasActiveFilters ? "Try resetting some of the filters above" : "Check back soon"}
                </p>
              </div>
            ) : (
              drawerJobs.map((job, idx) => {
                const isApplied = appliedJobs[job.id];
                const gradient = getCompanyGradient(job.company);

                return (
                  <div
                    key={job.id}
                    className={`pt-3.5 first:pt-0 group transition-all duration-200 ${
                      idx === 0
                        ? "p-3 rounded-xl bg-cyan-950/20 border border-cyan-500/25 shadow-inner"
                        : ""
                    }`}
                  >
                    {/* Top line: Company Logo + Job Title + Date */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        {/* Company Logo (Visible to all) */}
                        <CompanyLogo
                          company={job.company}
                          applyUrl={job.applyUrl}
                          className="w-9 h-9 shrink-0"
                        />
                        <div>
                          {/* Role Title & Pro Match Score Badge */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <h4 className="text-sm font-extrabold text-white group-hover:text-cyan-300 transition-colors leading-snug break-words">
                              {job.title}
                            </h4>
                            {isPro && (
                              <MatchScoreBadge
                                job={{
                                  id: job.id,
                                  title: job.title,
                                  company: job.company,
                                  location: job.location,
                                  salary_text: job.salaryText || undefined,
                                  apply_url: job.applyUrl,
                                }}
                                size="sm"
                              />
                            )}
                          </div>

                          {/* Company Name (Visible to all) */}
                          <div className="text-xs font-medium text-slate-400 flex items-center gap-1.5 mt-0.5">
                            <span className="text-slate-300 font-semibold">{job.company || "Verified Company"}</span>
                            <span>•</span>
                          </div>
                        </div>
                      </div>

                      {/* Posted Date: Pro vs Free Gated */}
                      {isPro ? (
                        <span className="text-[11px] font-mono text-cyan-400/80 whitespace-nowrap flex items-center gap-1">
                          <Clock className="w-3 h-3 text-cyan-400" />
                          {formatJobDate(job.postedAt || job.discoveredAt)}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={handleLockedClick}
                          title="Unlock live post date with Pro"
                          className="text-[11px] font-mono text-slate-400 whitespace-nowrap flex items-center gap-1 cursor-pointer hover:text-white"
                        >
                          <span className="filter blur-[3px] select-none">2h ago</span>
                          <Lock className="w-2.5 h-2.5 text-[#2563EB]" />
                        </button>
                      )}
                    </div>

                    {/* Metadata & Salary: Pro vs Free Gated */}
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      {/* Salary */}
                      {isPro ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-bold font-mono">
                          <DollarSign className="w-3 h-3 text-emerald-400" />
                          {job.salaryText || "Not disclosed"}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={handleLockedClick}
                          title="Unlock verified compensation with Pro"
                          className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-[#2563EB]/10 border border-[#2563EB]/30 text-xs font-mono cursor-pointer hover:bg-[#2563EB]/20 transition-all text-blue-300"
                        >
                          <span className="filter blur-[3.5px] select-none text-blue-200">
                            {job.salaryText || "••••••••••••••••"}
                          </span>
                          <Lock className="w-3 h-3 text-[#2563EB]" />
                        </button>
                      )}

                      {/* Location */}
                      {isPro ? (
                        <span className="px-2 py-0.5 rounded-md bg-slate-800/80 border border-slate-700/60 text-[10px] font-medium text-slate-300">
                          {job.location}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={handleLockedClick}
                          title="Unlock exact location with Pro"
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-900/90 border border-[#2563EB]/30 text-[10px] cursor-pointer hover:border-[#2563EB]/60 transition-all text-slate-300"
                        >
                          <span className="filter blur-[3px] select-none text-slate-400 font-mono">
                            San Francisco, CA
                          </span>
                          <Lock className="w-2.5 h-2.5 text-[#2563EB]" />
                        </button>
                      )}

                      {job.seniority && (
                        <span className="px-2 py-0.5 rounded-md bg-slate-800/80 border border-slate-700/60 text-[10px] font-medium text-slate-300 capitalize">
                          {job.seniority}
                        </span>
                      )}
                    </div>

                    {/* Action Row */}
                    <div className="mt-3 flex items-center justify-between gap-2 pt-2 border-t border-slate-800/40">
                      {job.verified ? (
                        <div className="flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
                          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Verified Direct Source</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 text-[11px] text-slate-400 font-medium">
                          <span>Verified Active</span>
                        </div>
                      )}

                      {/* Actions: Track Application + Apply Button */}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleTrackJob(job)}
                          className="inline-flex items-center gap-1 px-2.5 py-2 min-h-[38px] rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-all border border-slate-700 cursor-pointer"
                          title="Save to Application Pipeline Tracker"
                        >
                          <BookmarkPlus className="w-3.5 h-3.5 text-blue-400" />
                          <span>Track</span>
                        </button>

                        {/* Apply Button: Pro vs Free Gated */}
                        {isPro ? (
                          <a
                            href={sanitizeExternalUrl(job.applyUrl) || "#"}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => handleApplyClick(job.id)}
                            className={`inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[38px] rounded-lg text-xs font-bold transition-all shadow-md ${
                              isApplied
                                ? "bg-emerald-600 text-white"
                                : "bg-cyan-500 hover:bg-cyan-400 text-slate-950 shadow-cyan-500/30 hover:shadow-cyan-400/50"
                            }`}
                          >
                            {isApplied ? (
                              <>
                                <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                                <span>Link Opened</span>
                              </>
                            ) : (
                              <>
                                <span>Direct Apply</span>
                                <ExternalLink className="w-3.5 h-3.5" />
                              </>
                            )}
                          </a>
                        ) : (
                          <button
                            type="button"
                            onClick={handleLockedClick}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[38px] rounded-lg text-xs font-bold transition-all shadow-md bg-[#2563EB] hover:bg-[#1D4ED8] text-white shadow-blue-600/30 cursor-pointer"
                          >
                            <Lock className="w-3.5 h-3.5 text-white" />
                            <span>Direct Apply</span>
                            <span className="px-1.5 py-0.5 rounded bg-white/20 text-[10px] font-mono uppercase tracking-wider">
                              Pro
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}

            {/* Load More Button */}
            {jobsHasMore && (
              <div className="pt-3 text-center">
                <button
                  type="button"
                  disabled={jobsLoading}
                  onClick={() => fetchCityJobs(selectedCity, jobsPage + 1, true)}
                  className="px-4 py-2 min-h-[40px] rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-cyan-300 hover:text-white transition-all border border-cyan-500/30 cursor-pointer disabled:opacity-50"
                >
                  {jobsLoading ? (
                    <span className="flex items-center gap-1.5">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Loading...
                    </span>
                  ) : (
                    `Load More (${drawerJobs.length} of ${jobsTotal})`
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Drawer Footer Actions with Filter Synchronization */}
          <div className="p-3 bg-slate-950 border-t border-cyan-500/20 flex items-center justify-between text-xs">
            <span className="text-slate-400">
              Showing {drawerJobs.length} of {jobsTotal} roles
            </span>
            <Link
              href={exploreAllUrl}
              className="inline-flex items-center gap-1 min-h-[38px] py-1 font-bold text-cyan-400 hover:text-cyan-300"
            >
              <span>Explore all in {selectedCity.name}</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* FLOATING PANEL: Map Style Layers & Marker Key                              */}
      {/* ========================================================================= */}
      {showLayersPanel && (
        <div className="absolute bottom-20 right-3 sm:bottom-4 sm:right-4 z-30 flex flex-col gap-2 p-3.5 rounded-2xl bg-slate-950/95 border border-slate-800 backdrop-blur-md text-[11px] text-slate-300 shadow-2xl max-w-[280px] sm:max-w-xs pointer-events-auto animate-scaleUp">
          <div className="flex items-center justify-between text-cyan-400 font-bold uppercase tracking-wider text-[10px]">
            <span className="flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-cyan-400" />
              MAP LAYERS
            </span>
            <button
              type="button"
              onClick={() => setShowLayersPanel(false)}
              className="p-1 min-h-[36px] min-w-[36px] flex items-center justify-center text-slate-500 hover:text-white cursor-pointer"
              aria-label="Close map layers panel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex flex-col gap-1.5 mt-1">
            {(Object.keys(GLOBE_MAP_LABELS) as GlobeMapStyle[]).map((style) => (
              <button
                key={style}
                type="button"
                onClick={() => setMapStyle(style)}
                className={`flex items-center justify-between px-3 py-2 min-h-[38px] rounded-xl text-xs font-semibold transition-all ${
                  mapStyle === style
                    ? "bg-cyan-500 text-slate-950"
                    : "bg-slate-900 text-slate-300 hover:bg-slate-800"
                }`}
              >
                <span>{GLOBE_MAP_LABELS[style]}</span>
                {mapStyle === style && <CheckCircle2 className="w-3.5 h-3.5" />}
              </button>
            ))}
          </div>

          <div className="pt-2 border-t border-slate-800/80 space-y-1 text-[10px] text-slate-400">
            <div className="flex items-center gap-1.5">
              <span
                className="w-3 h-3 rounded-full shrink-0 border border-white/60"
                style={{ backgroundColor: MARKER_COLOR_CSS, boxShadow: `0 0 8px ${MARKER_GLOW_CSS}` }}
              />
              <span>City marker: size scales with job count</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full border-2 border-white bg-slate-900 shrink-0" />
              <span>Selected marker: Glowing white ring</span>
            </div>
            <div className="flex items-center gap-1.5">
              <ShieldCheck className="w-3 h-3 text-emerald-400 shrink-0" />
              <span>Verified badge: Official company origin</span>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Floating Layers Toggle Button (visible when drawer closed) */}
      {!selectedCity && !showLayersPanel && (
        <div className="absolute bottom-4 right-4 z-20 lg:hidden pointer-events-auto">
          <button
            type="button"
            onClick={() => setShowLayersPanel(true)}
            aria-label="Switch map style"
            className="flex items-center gap-1.5 px-3.5 py-2 min-h-[44px] rounded-full bg-slate-950/90 border border-slate-700/80 text-xs font-semibold text-cyan-300 shadow-lg backdrop-blur-md cursor-pointer"
          >
            <Layers className="w-4 h-4 text-cyan-400" />
            <span>Layers</span>
          </button>
        </div>
      )}

      {/* ========================================================================= */}
      {/* BOTTOM-LEFT HUD: Radar Navigation Guide (collapsible, auto-hides on first  */}
      {/* interaction, dismissal remembered in localStorage)                         */}
      {/* ========================================================================= */}
      {showNavHint ? (
        <div className="absolute bottom-4 left-4 z-20 hidden sm:flex flex-col gap-1.5 p-3 rounded-xl bg-slate-950/85 border border-slate-800 backdrop-blur-md text-[11px] text-slate-400 max-w-xs shadow-lg animate-fadeIn">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-cyan-400 font-bold uppercase tracking-wider text-[10px]">
              <span className={`w-1.5 h-1.5 rounded-full bg-cyan-400 ${prefersReducedMotion ? "" : "animate-ping"}`} />
              <span>HOW TO NAVIGATE RADAR</span>
            </div>
            <button
              type="button"
              onClick={dismissNavHint}
              aria-label="Dismiss navigation guide"
              className="pointer-events-auto p-1 min-h-[28px] min-w-[28px] flex items-center justify-center text-slate-500 hover:text-white cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="leading-relaxed text-slate-300 pointer-events-none">
            • Filter by <span className="text-cyan-300 font-semibold">Country, Category, Remote, or Internships</span> above.
            <br />
            • Click any <span className="text-cyan-300 font-semibold">City Marker</span> for cinematic fly-in & job drawer.
            <br />
            • Drag to orbit • Scroll to zoom • Arrow keys rotate • +/- zoom • Esc closes.
          </p>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowNavHint(true)}
          aria-label="Show navigation guide"
          title="How to navigate"
          className="absolute bottom-4 left-4 z-20 hidden sm:flex items-center justify-center w-9 h-9 rounded-full bg-slate-950/85 border border-slate-800 backdrop-blur-md text-cyan-400 shadow-lg pointer-events-auto hover:text-white hover:border-cyan-500/60 transition-colors"
        >
          <span className="text-xs font-bold">?</span>
        </button>
      )}

      {/* ========================================================================= */}
      {/* PRO UPGRADE MODAL                                                         */}
      {/* ========================================================================= */}
      <PaywallModal
        open={isPaywallOpen}
        onOpenChange={setIsPaywallOpen}
        user={currentUser}
        onSuccess={() => setIsPro(true)}
      />
    </div>
  );
}
