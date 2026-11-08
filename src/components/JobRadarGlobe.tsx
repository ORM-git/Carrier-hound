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
  DENSITY_TIERS,
  getDensityColor,
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
  const disposablesRef = useRef<Array<{ dispose: () => void }>>([]);

  // Camera animation target
  const targetCameraPosRef = useRef<THREE.Vector3 | null>(null);
  const targetLookAtRef = useRef<THREE.Vector3 | null>(null);
  const isTransitioningRef = useRef<boolean>(false);

  // Direct DOM references for 60 FPS HTML marker transforms (ZERO React re-renders)
  const markerElementsRef = useRef<Map<string, HTMLButtonElement>>(new Map());

  // State
  const [webglSupported, setWebglSupported] = useState<boolean>(true);
  const [telemetry, setTelemetry] = useState<RadarTelemetryPayload | null>(null);
  const [isLoadingTelemetry, setIsLoadingTelemetry] = useState<boolean>(true);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);

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
  const [showLegend, setShowLegend] = useState<boolean>(false);

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
          )
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
          company: row.company || "Verified ATS Company",
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
    camera.position.set(0, isMobile ? 1.5 : 4, isMobile ? 22 : 14);
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

    // Starfield
    const starsCount = isMobile ? 500 : 1200;
    const starsGeo = new THREE.BufferGeometry();
    const starPositions = new Float32Array(starsCount * 3);
    for (let i = 0; i < starsCount * 3; i += 3) {
      starPositions[i] = (Math.random() - 0.5) * 160;
      starPositions[i + 1] = (Math.random() - 0.5) * 160;
      starPositions[i + 2] = (Math.random() - 0.5) * 160;
    }
    starsGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const starsMat = new THREE.PointsMaterial({
      color: 0x93c5fd,
      size: 0.6,
      transparent: true,
      opacity: 0.7,
    });
    const starField = new THREE.Points(starsGeo, starsMat);
    scene.add(starField);
    disposablesRef.current.push(starsGeo, starsMat);

    // Earth Sphere
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(
      "/globe/earth-night.jpg",
      (texture) => {
        if (isCancelled) {
          // Unmounted mid-load: free the decoded texture immediately.
          texture.dispose();
          return;
        }
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        const earthGeo = new THREE.SphereGeometry(5, isMobile ? 48 : 64, isMobile ? 48 : 64);
        const earthMat = new THREE.MeshStandardMaterial({
          map: texture,
          roughness: 0.65,
          metalness: 0.15,
        });
        const earthMesh = new THREE.Mesh(earthGeo, earthMat);
        scene.add(earthMesh);
        disposablesRef.current.push(earthGeo, earthMat, texture);
      },
      undefined,
      () => {
        const fallbackMat = new THREE.MeshStandardMaterial({
          color: 0x0c1b33,
          wireframe: true,
        });
        const earthGeo = new THREE.SphereGeometry(5, 32, 32);
        const earthMesh = new THREE.Mesh(earthGeo, fallbackMat);
        scene.add(earthMesh);
        disposablesRef.current.push(earthGeo, fallbackMat);
      }
    );

    // Atmosphere Shells
    const atmosGeo = new THREE.SphereGeometry(5.18, 48, 48);
    const atmosMat = new THREE.MeshBasicMaterial({
      color: 0x06b6d4,
      transparent: true,
      opacity: 0.18,
      side: THREE.BackSide,
    });
    const atmosMesh = new THREE.Mesh(atmosGeo, atmosMat);
    scene.add(atmosMesh);

    const haloGeo = new THREE.SphereGeometry(5.35, 48, 48);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0x0284c7,
      transparent: true,
      opacity: 0.08,
      side: THREE.BackSide,
    });
    const haloMesh = new THREE.Mesh(haloGeo, haloMat);
    scene.add(haloMesh);
    disposablesRef.current.push(atmosGeo, atmosMat, haloGeo, haloMat);

    // Group for dynamic 3D marker meshes
    const markersGroup = new THREE.Group();
    scene.add(markersGroup);
    markersGroupRef.current = markersGroup;

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

    // Visibility change handler
    const handleVisibilityChange = () => {
      if (document.hidden) {
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
        }[] = [];

        for (let i = 0; i < data.cities.length; i++) {
          const city = data.cities[i];
          const el = markerElementsRef.current.get(city.id);
          if (!el) continue;

          const { x, y, z } = latLngToVector3(city.coordinates[1], city.coordinates[0], 5.05);
          scratchWorldPos.set(x, y, z);
          scratchMarkerDir.copy(scratchWorldPos).normalize();
          const dot = camPos.dot(scratchMarkerDir);
          const isFacingCamera = dot > 0.15;
          const isMatch = matchesFilters(city, cFilter, rFilter);

          if (isFacingCamera && isMatch) {
            scratchScreenVec.copy(scratchWorldPos).project(camera);
            if (scratchScreenVec.z < 1) {
              const screenX = (scratchScreenVec.x * 0.5 + 0.5) * cWidth;
              const screenY = (-scratchScreenVec.y * 0.5 + 0.5) * cHeight;
              el.style.transform = `translate3d(${screenX}px, ${screenY}px, 0) translate(-50%, -50%)`;
              el.style.display = "flex";
              const isSelected = selectedCityRef.current?.id === city.id;
              visibleMarkers.push({ city, el, screenX, screenY, isSelected });
              continue;
            }
          }
          el.style.display = "none";
        }

        // Prioritize selected city and higher density cities for badge display
        visibleMarkers.sort((a, b) => {
          if (a.isSelected) return -1;
          if (b.isSelected) return 1;
          return (b.city.totalCount || 0) - (a.city.totalCount || 0);
        });

        // Collision avoidance: keep diode dots visible, hide label badge if within 55px of another label
        const placedLabelPositions: { x: number; y: number }[] = [];
        for (const marker of visibleMarkers) {
          const badgeEl = marker.el.querySelector(".city-tag-badge") as HTMLElement | null;
          if (!badgeEl) continue;

          if (marker.isSelected) {
            badgeEl.style.opacity = "1";
            badgeEl.style.pointerEvents = "auto";
            placedLabelPositions.push({ x: marker.screenX, y: marker.screenY });
            continue;
          }

          let collides = false;
          for (const pos of placedLabelPositions) {
            const dist = Math.hypot(marker.screenX - pos.x, marker.screenY - pos.y);
            if (dist < 55) {
              collides = true;
              break;
            }
          }

          if (collides) {
            badgeEl.style.opacity = "0";
            badgeEl.style.pointerEvents = "none";
          } else {
            badgeEl.style.opacity = "1";
            badgeEl.style.pointerEvents = "auto";
            placedLabelPositions.push({ x: marker.screenX, y: marker.screenY });
          }
        }
      }

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      isCancelled = true;
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);

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
      const density = getDensityColor(city.totalCount);
      const radius = getMarkerRadius(city.totalCount);

      const diodeGeo = new THREE.SphereGeometry(radius * 0.7, 16, 16);
      const diodeMat = new THREE.MeshBasicMaterial({
        color: density.hex,
        transparent: true,
        opacity: isVisible ? 0.95 : 0,
      });
      const diode = new THREE.Mesh(diodeGeo, diodeMat);
      diode.position.copy(markerVec);
      group.add(diode);

      const ringGeo = new THREE.RingGeometry(radius * 1.1, radius * 1.8, 24);
      const ringMat = new THREE.MeshBasicMaterial({
        color: density.hex,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: isVisible ? 0.6 : 0,
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
      targetCameraPosRef.current = new THREE.Vector3(0, isMobile ? 3.5 : 4, isMobile ? 16.5 : 14);
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
    targetCameraPosRef.current = new THREE.Vector3(0, isMobile ? 3.5 : 4, isMobile ? 16.5 : 14);
    targetLookAtRef.current = new THREE.Vector3(0, 0, 0);
    isTransitioningRef.current = true;
  };

  const handleApplyClick = (jobId: string) => {
    setAppliedJobs((prev) => ({ ...prev, [jobId]: true }));
  };

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

      {/* ========================================================================= */}
      {/* 3D PROJECTED HTML CITY MARKERS (Zero React Re-render Animation Loop)      */}
      {/* ========================================================================= */}
      {webglSupported && telemetry && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
          {telemetry.cities.map((city) => {
            const density = getDensityColor(city.totalCount);
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
                className="city-marker-btn pointer-events-auto flex flex-col items-center cursor-pointer group transition-transform duration-200 hover:scale-115 focus:outline-none"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCitySelect(city);
                }}
              >
                {/* Concentric Radar Ping Rings */}
                <div
                  className="absolute -top-3.5 -left-3.5 w-11 h-11 rounded-full animate-radar-ping pointer-events-none opacity-40"
                  style={{ backgroundColor: density.css }}
                />
                <div
                  className="absolute -top-3.5 -left-3.5 w-11 h-11 rounded-full animate-radar-ping-delay pointer-events-none opacity-30"
                  style={{ backgroundColor: density.css }}
                />

                {/* Core Diode with Selected Glowing Ring */}
                <div
                  className={`relative w-4 h-4 rounded-full border-2 flex items-center justify-center transition-all ${
                    isSelected
                      ? "ring-4 ring-white ring-offset-2 ring-offset-slate-950 scale-130 border-white shadow-[0_0_20px_#ffffff]"
                      : "border-white/80 group-hover:scale-115"
                  }`}
                  style={{
                    backgroundColor: density.css,
                    boxShadow: isSelected ? "0 0 20px #ffffff" : `0 0 12px ${density.glowCss}`,
                  }}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-white" />
                </div>

                {/* City Tag Badge */}
                <div
                  className={`city-tag-badge mt-1.5 px-2.5 py-0.5 rounded-full border text-[11px] font-semibold shadow-[0_4px_14px_rgba(0,0,0,0.85)] backdrop-blur-md flex items-center gap-1.5 whitespace-nowrap transition-all group-hover:opacity-100! group-hover:pointer-events-auto! ${
                    isSelected
                      ? "bg-slate-950 border-white text-white ring-2 ring-white/50"
                      : "bg-slate-950/90 border-slate-700/80 text-slate-200 group-hover:border-cyan-400 group-hover:text-white"
                  }`}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full animate-pulse"
                    style={{ backgroundColor: density.css }}
                  />
                  <span>{city.name}</span>
                  <span className="font-mono font-normal opacity-85" style={{ color: density.css }}>
                    ({city.totalCount})
                  </span>
                </div>
              </button>
            );
          })}
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

            {/* Legend Toggle */}
            <button
              type="button"
              onClick={() => setShowLegend((prev) => !prev)}
              title="Density Color Scale Legend"
              className={`p-2 min-w-[38px] min-h-[38px] flex items-center justify-center rounded-full border text-xs font-medium transition-all backdrop-blur-md ${
                showLegend
                  ? "bg-violet-950/80 border-violet-500 text-violet-300"
                  : "bg-slate-950/80 border-slate-700 text-slate-400 hover:text-white"
              }`}
            >
              <Layers className="w-4 h-4 text-violet-400" />
            </button>
          </div>
        </div>

        {/* ===================================================================== */}
        {/* Row 2: THE 4 LIGHT FILTERS (Country, Category, Remote, Internship)    */}
        {/* ===================================================================== */}
        <div className="pointer-events-auto flex items-center justify-start sm:justify-center gap-1.5 p-1 sm:p-1.5 rounded-2xl bg-slate-950/90 border border-slate-800/90 backdrop-blur-xl shadow-2xl max-w-full overflow-x-auto no-scrollbar mx-auto px-2">
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
            title="Toggle Verified ATS roles only"
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
      </div>

      {/* ========================================================================= */}
      {/* POP-OUT JOB CARDS DRAWER / HUD (Real Supabase Jobs + Free vs Pro Gating)  */}
      {/* ========================================================================= */}
      {/* ========================================================================= */}
      {/* SLIDE-OVER / BOTTOM-SHEET JOB DRAWER                                      */}
      {/* ========================================================================= */}
      {selectedCity && (
        <div className="fixed inset-x-0 bottom-0 sm:absolute sm:inset-x-auto sm:bottom-6 sm:left-auto sm:right-6 sm:w-[480px] z-40 max-h-[72dvh] sm:max-h-[78vh] flex flex-col rounded-t-3xl sm:rounded-2xl bg-slate-950/95 border-t sm:border border-cyan-500/40 backdrop-blur-2xl shadow-[0_-12px_45px_rgba(0,0,0,0.85)] sm:shadow-[0_12px_50px_rgba(6,182,212,0.3)] animate-slideUp sm:animate-pop-out overflow-hidden pb-[env(safe-area-inset-bottom,1.5rem)] sm:pb-0">
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
                  {hasActiveFilters ? "Try resetting some of the filters above" : "Check back after the next daily ingestion cycle"}
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
                          <span>Verified Direct ATS</span>
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
      {/* FLOATING LEGEND: Density Color Scale & Verification HUD                    */}
      {/* ========================================================================= */}
      {showLegend && (
        <div className="absolute bottom-20 right-3 sm:bottom-4 sm:right-4 z-30 flex flex-col gap-2 p-3.5 rounded-2xl bg-slate-950/95 border border-slate-800 backdrop-blur-md text-[11px] text-slate-300 shadow-2xl max-w-[280px] sm:max-w-xs pointer-events-auto animate-scaleUp">
          <div className="flex items-center justify-between text-cyan-400 font-bold uppercase tracking-wider text-[10px]">
            <span className="flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-cyan-400" />
              JOB DENSITY SCALE
            </span>
            <button
              type="button"
              onClick={() => setShowLegend(false)}
              className="p-1 min-h-[36px] min-w-[36px] flex items-center justify-center text-slate-500 hover:text-white cursor-pointer"
              aria-label="Close legend"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 mt-1">
            {DENSITY_TIERS.map((tier) => (
              <div key={tier.label} className="flex items-center gap-2">
                <span
                  className="w-3 h-3 rounded-full shrink-0 border border-white/60"
                  style={{ backgroundColor: tier.css, boxShadow: `0 0 8px ${tier.glowCss}` }}
                />
                <span className="text-slate-300 font-mono text-[11px]">{tier.label}</span>
              </div>
            ))}
          </div>

          <div className="pt-2 border-t border-slate-800/80 space-y-1 text-[10px] text-slate-400">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full border-2 border-white bg-slate-900 shrink-0" />
              <span>Selected marker: Glowing white ring</span>
            </div>
            <div className="flex items-center gap-1.5">
              <ShieldCheck className="w-3 h-3 text-emerald-400 shrink-0" />
              <span>Verified badge: Official ATS origin</span>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Floating Legend Toggle Button (visible when drawer closed) */}
      {!selectedCity && !showLegend && (
        <div className="absolute bottom-4 right-4 z-20 lg:hidden pointer-events-auto">
          <button
            type="button"
            onClick={() => setShowLegend(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 min-h-[44px] rounded-full bg-slate-950/90 border border-slate-700/80 text-xs font-semibold text-cyan-300 shadow-lg backdrop-blur-md cursor-pointer"
          >
            <Layers className="w-4 h-4 text-cyan-400" />
            <span>Legend</span>
          </button>
        </div>
      )}

      {/* ========================================================================= */}
      {/* BOTTOM-LEFT HUD: Radar Navigation Guide                                   */}
      {/* ========================================================================= */}
      <div className="absolute bottom-4 left-4 z-20 hidden md:flex flex-col gap-1.5 p-3 rounded-xl bg-slate-950/85 border border-slate-800 backdrop-blur-md text-[11px] text-slate-400 pointer-events-none max-w-xs shadow-lg">
        <div className="flex items-center gap-2 text-cyan-400 font-bold uppercase tracking-wider text-[10px]">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />
          <span>HOW TO NAVIGATE RADAR</span>
        </div>
        <p className="leading-relaxed text-slate-300">
          • Filter by <span className="text-cyan-300 font-semibold">Country, Category, Remote, or Internships</span> above.
          <br />
          • Click any <span className="text-cyan-300 font-semibold">City Marker</span> for cinematic fly-in & job drawer.
          <br />
          • Drag to orbit • Scroll to zoom.
        </p>
      </div>

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
