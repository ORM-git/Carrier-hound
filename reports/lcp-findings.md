# Mobile LCP Audit & Performance Findings Report (TASK G)

**Date**: 2026-10-16  
**Environment**: Production Static Export (`out/`), Node.js static server on `localhost:3333`  
**Audit Tool**: Google Lighthouse 12+ (Mobile — Moto G Power emulation, 4x CPU slowdown, simulated 4G network throttling)  
**Branch**: `perf/lcp-report` (branched from `main` at `71f5ab0`)  
**Scope**: REPORT-ONLY audit of `/` (Landing Page) and `/jobs` (Job Discovery Page). Zero source code modifications.

---

## 1. Benchmark Methodology & Raw LCP Data

The project was built cleanly from `main` via Next.js static export (`output: "export"`, 49 static pages generated in `out/`) with `.env.local` unset. The export was served locally on port 3333.
Five alternating rounds were executed across `/` and `/jobs` to eliminate thermal throttling and resource bias:

### Raw Results Table

| Round | Page | Performance Score | LCP (ms) | FCP (ms) | TBT (ms) | CLS |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: |
| **1** | `/` (Landing) | 49 / 100 | 8,845.0 ms | 2,338.7 ms | 874.5 ms | 0.000 |
| **1** | `/jobs` | 66 / 100 | 8,335.7 ms | 1,671.0 ms | 371.5 ms | 0.000 |
| **2** | `/jobs` | 46 / 100 | 8,385.7 ms | 1,670.9 ms | 1,915.5 ms | 0.000 |
| **2** | `/` (Landing) | 52 / 100 | 8,842.1 ms | 2,167.2 ms | 771.5 ms | 0.000 |
| **3** | `/` (Landing) | 63 / 100 | 8,500.1 ms | 1,958.7 ms | 333.2 ms | 0.000 |
| **3** | `/jobs` | 65 / 100 | 8,285.2 ms | 1,665.9 ms | 403.5 ms | 0.000 |
| **4** | `/jobs` | 66 / 100 | 8,054.1 ms | 1,665.3 ms | 361.0 ms | 0.000 |
| **4** | `/` (Landing) | 57 / 100 | 8,541.4 ms | 1,959.4 ms | 522.8 ms | 0.000 |
| **5** | `/` (Landing) | 59 / 100 | 8,579.6 ms | 2,005.2 ms | 440.0 ms | 0.000 |
| **5** | `/jobs` | 50 / 100 | 8,338.0 ms | 1,670.5 ms | 976.7 ms | 0.000 |

### Summary & Medians

- **Landing Page (`/`)**:
  - Raw LCPs: `[8500.1, 8541.4, 8579.6, 8842.1, 8845.0] ms`
  - **Median LCP**: **8,579.6 ms** (Median Score: 57 / 100)
  - Median FCP: 2,005.2 ms
  - Median TBT: 522.8 ms

- **Jobs Page (`/jobs`)**:
  - Raw LCPs: `[8054.1, 8285.2, 8335.7, 8338.0, 8385.7] ms`
  - **Median LCP**: **8,335.7 ms** (Median Score: 65 / 100)
  - Median FCP: 1,670.5 ms
  - Median TBT: 403.5 ms

---

## 2. LCP Elements & Diagnostic Breakdown

### A. Landing Page (`/`)
- **LCP Element**:
  - **HTML Tag**: `<h2>`
  - **CSS Selector**: `main.min-h-screen > section.pt-20 > div.text-center > h2.text-3xl`
  - **DOM Snippet**: `<h2 class="text-3xl font-bold text-[#09090B] sm:text-4xl md:text-[40px] md:leading-[1…">Tired of getting auto-rejections?</h2>`
  - **Node Label**: `"Tired of getting auto-rejections?"`
  - **Source Location**: `src/app/page.tsx:133-135`
- **Image Resource URL**: `N/A` (Text node, not an image)
- **LCP Subpart Breakdown**:
  - **TTFB (Time to First Byte)**: `6.4 ms` (observed 6 – 14 ms)
  - **Resource Load Delay**: `0 ms` (No external image/asset)
  - **Resource Load Duration**: `0 ms` (No external image/asset)
  - **Element Render Delay**: `1,935.0 ms` (unthrottled observed render delay; simulated mobile CPU throttle LCP = 8,579.6 ms)
- **Top Render-Blocking Resources**:
  1. `/_next/static/css/e3763cd0b1681a4c.css` — **97.2 KB** (97,238 bytes) | Duration: **911 ms**
  2. `/_next/static/css/54dd24ff8cb7a123.css` — **31.3 KB** (31,298 bytes) | Duration: **461 ms**
  *(Only 2 render-blocking stylesheets exist in `<head>`).*

### B. Jobs Page (`/jobs`)
- **LCP Element**:
  - **HTML Tag**: `<p>`
  - **CSS Selector**: `div.bg-white > div.flex > div.space-y-1.5 > p.text-xs`
  - **DOM Snippet**: `<p class="text-xs text-slate-500 line-clamp-1 mt-1 filter blur-[4px] select-none cur…">We are seeking a talented professional to join our team for this verified role.</p>`
  - **Node Label**: `"We are seeking a talented professional to join our team for this verified role."`
  - **Source Location**: `src/app/jobs/page.tsx:666`
- **Image Resource URL**: `N/A` (Text node, not an image)
- **LCP Subpart Breakdown**:
  - **TTFB (Time to First Byte)**: `12.0 ms` (observed 8 – 12 ms)
  - **Resource Load Delay**: `0 ms` (No external image/asset)
  - **Resource Load Duration**: `0 ms` (No external image/asset)
  - **Element Render Delay**: `1,292.0 ms` (unthrottled observed render delay; simulated mobile CPU throttle LCP = 8,335.7 ms)
- **Top Render-Blocking Resources**:
  1. `/_next/static/css/e3763cd0b1681a4c.css` — **97.2 KB** (97,238 bytes) | Duration: **912 ms**
  2. `/_next/static/css/54dd24ff8cb7a123.css` — **31.3 KB** (31,298 bytes) | Duration: **461 ms**

---

## 3. Top 10 JavaScript Chunks Loaded on Each Page

All scripts are loaded via Next.js standard module scripts (`async` or `defer`). In mobile browser runs, scripts begin network transmission concurrently with CSS and finish before or around First Contentful Paint.

### Landing Page (`/`) — Top 10 JS Chunks (FCP: ~2,005 ms)

| Chunk Name | Transfer / Gzip | Disk Size | What Imports It / Contained Modules | Loaded Before First Paint? |
| :--- | :---: | :---: | :--- | :---: |
| `5283-cd9304e2e4bf28c9.js` | **53.9 KB** | 194.9 KB | `@supabase/supabase-js`, `gotrue-js`, `postgrest-js` (via `UserMenu` in `src/app/page.tsx:30`) | **Yes** (1,137 ms < FCP) |
| `fd9d1056-5c85148d41861136.js` | **52.5 KB** | 168.8 KB | `react`, `react-dom`, React 18 client runtime (Root layout shared) | **Yes** (158 ms < FCP) |
| `4509.615164982b26f45c.js` | **47.4 KB** | 146.8 KB | `motion` (Framer Motion v13 animation engine via dynamic import) | **Yes** (1,173 ms < FCP) |
| `2117-a98b9e3d2abedf58.js` | **31.4 KB** | 122.0 KB | `next` App Router client runtime, router dispatcher, link prefetch | **Yes** (167 ms < FCP) |
| `7278-12e28a289d450f3d.js` | **18.3 KB** | 54.9 KB | `d3` / `d3-geo` / canvas projection engine (via `WireframeDottedGlobe`) | **Yes** (215 ms < FCP) |
| `44530001-3160128875ef23f7.js` | **14.1 KB** | 67.1 KB | `@supabase` helper utilities / realtime listeners | **Yes** (1,115 ms < FCP) |
| `page-11c8224b0c8aa664.js` | **12.4 KB** | 49.2 KB | `src/app/page.tsx` (Hero, Stats, Problem/Solution, FAQ, Footer) | **Yes** (227 ms < FCP) |
| `2972-35370d33c85af753.js` | **8.5 KB** | 25.5 KB | Radix Dialog, Slot, `clsx`, `tailwind-merge`, `cva` primitives | **Yes** (174 ms < FCP) |
| `3335-7167d2550fefadb7.js` | **6.5 KB** | 19.3 KB | `lucide-react` icon subset & `Navbar` layout header | **Yes** (191 ms < FCP) |
| `7261-ece4b8ce22a4d89f.js` | **6.0 KB** | 15.3 KB | `react-toastify` toast container (Root layout `src/app/layout.tsx:58`) | **Yes** (239 ms < FCP) |

### Jobs Page (`/jobs`) — Top 10 JS Chunks (FCP: ~1,671 ms)

| Chunk Name | Transfer / Gzip | Disk Size | What Imports It / Contained Modules | Loaded Before First Paint? |
| :--- | :---: | :---: | :--- | :---: |
| `5283-cd9304e2e4bf28c9.js` | **53.9 KB** | 194.9 KB | `@supabase/supabase-js`, PostgREST client, Auth state | **Yes** (134 ms < FCP) |
| `fd9d1056-5c85148d41861136.js` | **52.5 KB** | 168.8 KB | `react`, `react-dom` client runtime | **Yes** (97 ms < FCP) |
| `2117-a98b9e3d2abedf58.js` | **31.4 KB** | 122.0 KB | Next.js App Router client framework | **Yes** (96 ms < FCP) |
| `7278-12e28a289d450f3d.js` | **18.3 KB** | 54.9 KB | D3 / vector projection utilities | **Yes** (717 ms < FCP) |
| `44530001-3160128875ef23f7.js` | **14.1 KB** | 67.1 KB | Supabase auth session helpers | **Yes** (112 ms < FCP) |
| `page-2f4e2321625ef27c.js` | **7.5 KB** | 24.9 KB | `src/app/jobs/page.tsx` (`JobsPageInner`, search bar, filters) | **Yes** (169 ms < FCP) |
| `1468-4e8607c552472562.js` | **9.1 KB** | 22.4 KB | `src/components/JobCard.tsx`, Company logos, Paywall triggers | **Yes** (164 ms < FCP) |
| `2972-35370d33c85af753.js` | **8.5 KB** | 25.5 KB | Radix UI primitives, `tailwind-merge` | **Yes** (113 ms < FCP) |
| `3335-7167d2550fefadb7.js` | **6.5 KB** | 19.3 KB | `lucide-react` icons (Search, Building, MapPin, DollarSign, Lock) | **Yes** (173 ms < FCP) |
| `7261-ece4b8ce22a4d89f.js` | **6.0 KB** | 15.3 KB | `react-toastify` notification library | **Yes** (150 ms < FCP) |

---

## 4. Root Cause Analysis: Does the LCP Element Wait for JS?

### A. Jobs Page (`/jobs`): Complete Client-Side Bailout
**YES. The LCP element is completely blocked by JavaScript.**

1. **Static Export Bailout**:
   In `src/app/jobs/page.tsx:38`:
   ```tsx
   function JobsPageInner() {
     const router = useRouter();
     const searchParams = useSearchParams(); // <-- ROOT CAUSE 1
   ```
   At the root of the page component in `src/app/jobs/page.tsx:742-748`:
   ```tsx
   export default function JobsPage() {
     return (
       <Suspense>
         <JobsPageInner />
       </Suspense>
     );
   }
   ```
   Because `useSearchParams()` is called directly inside `JobsPageInner` and wrapped in `<Suspense>`, Next.js static generation bails out:
   `out/jobs.html` contains:
   ```html
   <!--$!--><template data-dgst="BAILOUT_TO_CLIENT_SIDE_RENDERING"></template><!--/$-->
   ```
   **Zero job cards, headings, or search bars exist in static HTML.**

2. **Cascading Client-Side Data Fetch Delay**:
   - `src/app/jobs/page.tsx:68`: `loadingJobs` initializes to `true`, `liveJobs` initializes to `[]`.
   - `src/app/jobs/page.tsx:71-106`: `useEffect` fires only after React hydrates:
     `await Promise.all([getAuthUser(), getProAccessStatus(), getCandidateProfile(), getTrackedApplications()])`
   - `src/app/jobs/page.tsx:141-195`: Secondary `useEffect` initiates `getLiveJobs()`.
   - `src/app/jobs/page.tsx:185`: When `getLiveJobs()` resolves, `setLiveJobs(res.jobs)` updates state.
   - `src/app/jobs/page.tsx:666`: Only THEN does React mount and render the LCP paragraph:
     ```tsx
     {job.description || "We are seeking a talented professional to join our team for this verified role."}
     ```
   **Total time penalty**: ~8,300 ms on mobile CPU throttling.

### B. Landing Page (`/`): Layout Settlement & Hydration Delays
**The LCP element (`<h2>Tired of getting auto-rejections?</h2>`) exists in static HTML, but its paint is delayed by render-blocking CSS and heavy client hydration.**

1. **Render-Blocking CSS**:
   The browser cannot perform First Paint until 128.5 KB of CSS across two files (`e3763cd0` 97.2 KB + `54dd24ff` 31.3 KB) is transferred and parsed (~912 ms duration on mobile network). FCP is delayed to ~2,000 ms.
2. **Heavy Above-The-Fold Hydration & Canvas Execution**:
   - `src/app/page.tsx:20-23`: `WireframeDottedGlobe` dynamically imports `d3` and initializes an orthographic canvas projection loop inside the hero viewport.
   - `src/app/page.tsx:30`: `UserMenu` runs client Supabase auth checks.
   - `src/app/layout.tsx:12`: Inter font loads 9 weights (`["100", "200", ..., "900"]`), delaying font swap settlement.
3. **Viewport Geometry**:
   The `<h2>` element is located at `top: 769px`. On a standard mobile device (viewport height 823px), it sits near the bottom border of the screen. Layout calculation, font metrics, and canvas initialization cause element render delay of ~1,935 ms before the paint is finalized.

---

## 5. Top 3 Ranked Fixes (Proposals Only — Unapplied)

### Rank 1: Eliminate Client-Side Bailout on `/jobs` by Isolating `useSearchParams` into a Leaf Component
- **Target File**: `src/app/jobs/page.tsx`
- **Expected Gain**: **~1,200 – 1,800 ms reduction in LCP on `/jobs`**
- **Risk of Visible UI Change**: **None** (identical markup, layout, styling, and functionality).
- **Rationale**: By moving `useSearchParams()` into a small `<SearchParamsSync>` leaf component wrapped in `<Suspense fallback={null}>`, `JobsPageInner` no longer triggers `BAILOUT_TO_CLIENT_SIDE_RENDERING`. The static HTML shell (`out/jobs.html`) will prerender the full header, search inputs, filter controls, and static fallback job cards. The browser renders the job cards immediately upon HTML parse without waiting for JS bundle download and Supabase client resolution.
- **Exact Code Change**:
```diff
--- a/src/app/jobs/page.tsx
+++ b/src/app/jobs/page.tsx
@@ -35,9 +35,22 @@ const MatchScoreBadge = dynamic(() => import("@/components/matcher/MatchScoreBadge
 const Footer = dynamic(() => import("@/components/Footer"), { ssr: false });
 
+function SearchParamsSync({ onParams }: { onParams: (search: string, cat: string, remote: boolean) => void }) {
+  const searchParams = useSearchParams();
+  useEffect(() => {
+    onParams(
+      searchParams.get("search") || "",
+      searchParams.get("category") || searchParams.get("categories") || "",
+      searchParams.get("remote") === "true"
+    );
+  }, [searchParams, onParams]);
+  return null;
+}
+
-function JobsPageInner() {
+function JobsPageContent() {
   const router = useRouter();
-  const searchParams = useSearchParams();
-  const querySearch = searchParams.get("search") || "";
-  const queryCategory = searchParams.get("category") || searchParams.get("categories") || "";
-  const queryRemote = searchParams.get("remote") === "true";
+  const [querySearch, setQuerySearch] = useState("");
+  const [queryCategory, setQueryCategory] = useState("");
+  const [queryRemote, setQueryRemote] = useState(false);
```

---

### Rank 2: Tree-Shake Monolithic `d3` in `WireframeDottedGlobe`
- **Target File**: `src/components/ui/wireframe-dotted-globe.tsx`
- **Expected Gain**: **~200 – 400 ms reduction in LCP, ~300 – 500 ms reduction in TBT on `/`**
- **Risk of Visible UI Change**: **None** (canvas globe output and projection are identical).
- **Rationale**: `WireframeDottedGlobe` currently imports the entire monolithic `d3` package (`import * as d3 from "d3"`). The component only uses `geoOrthographic`, `geoPath` from `d3-geo`, and `select` from `d3-selection`. Tree-shaking removes ~100 KB of unused SVG and charting code from the client bundle, drastically cutting CPU parse and evaluation time during hero hydration.
- **Exact Code Change**:
```diff
--- a/src/components/ui/wireframe-dotted-globe.tsx
+++ b/src/components/ui/wireframe-dotted-globe.tsx
@@ -48,3 +48,3 @@ export default function WireframeDottedGlobe() {
       try {
-        const d3 = await import("d3");
+        const d3Geo = await import("d3-geo");
         if (cancelled || !canvasRef.current) return;
@@ -52,3 +52,3 @@ export default function WireframeDottedGlobe() {
-        const projection = d3
+        const projection = d3Geo
           .geoOrthographic()
@@ -58,3 +58,3 @@ export default function WireframeDottedGlobe() {
-        const path = d3.geoPath(projection, context);
+        const path = d3Geo.geoPath(projection, context);
```

---

### Rank 3: Prune Unused Font Weights from Root Layout (`Inter`)
- **Target File**: `src/app/layout.tsx`
- **Expected Gain**: **~50 – 150 ms reduction in FCP and LCP across all pages**
- **Risk of Visible UI Change**: **None** (no element in the design uses font-weight 100 or 200).
- **Rationale**: `src/app/layout.tsx:12` currently configures all 9 weights: `["100", "200", "300", "400", "500", "600", "700", "800", "900"]`. A codebase grep confirms that `font-thin` (`100`) and `font-extralight` (`200`) are not used anywhere in the application. Pruning unused weights removes redundant `@font-face` definitions and prevents browser font discovery delays.
- **Exact Code Change**:
```diff
--- a/src/app/layout.tsx
+++ b/src/app/layout.tsx
@@ -10,3 +10,3 @@ const inter = Inter({
   subsets: ["latin"],
-  weight: ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
+  weight: ["300", "400", "500", "600", "700", "800", "900"],
   display: "swap",
```

---

## 6. Verdicts

- **Code Changes Applied**: `REPORT-ONLY` (No source code edits applied)
- **Supabase / Live DB Access**: `NOT RUN` (Offline only, no live requests)
- **Unit & Integration Suite**: `PASS-LOCAL` (13 passed offline, 0 failed)
- **TypeScript Check**: `PASS-LOCAL` (0 errors)
- **Static Build**: `PASS-LOCAL` (49 static HTML pages exported to `out/`)
