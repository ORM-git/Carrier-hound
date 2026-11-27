/**
 * Shared jsdom harness that mounts the real /jobs page with only its data boundaries mocked
 * (jobs transport, auth, Pro status, tracker, profile). FIXTURE data only: no network, no Supabase.
 *
 * Usage in a test file (vi.mock calls must live in the test file, so they are re-exported as factories):
 *   vi.mock("@/lib/jobs/service", jobsServiceMock);
 *   ...
 */
import { act } from "react";
import { vi } from "vitest";
import type { GetJobsResult, LiveJob } from "@/lib/jobs/service";

export type Transport = (opts: any) => Promise<GetJobsResult>;

export const h = {
  user: null as null | { id: string; email: string },
  isPro: false,
  apps: [] as any[],
  prefs: null as any,
  transport: (async () => ({ jobs: [], totalCount: 0, hasNextPage: false, nextCursor: null })) as Transport,
  byId: (async () => null) as (id: string, isPro: boolean) => Promise<LiveJob | null>,
  calls: [] as any[],
  desktop: false,
  router: { replace: vi.fn(), push: vi.fn(), back: vi.fn(), prefetch: vi.fn() },
};

export function resetHarness() {
  h.user = null;
  h.isPro = false;
  h.apps = [];
  h.prefs = null;
  h.transport = async () => ({ jobs: [], totalCount: 0, hasNextPage: false, nextCursor: null });
  h.byId = async () => null;
  h.calls = [];
  h.desktop = false;
  h.router.replace.mockReset();
  h.router.push.mockReset();
  io.instances.length = 0;
}

// --- module factories (pass to vi.mock in the test file) ---
export const jobsServiceMock = async () => {
  const actual = await vi.importActual<typeof import("@/lib/jobs/service")>("@/lib/jobs/service");
  return {
    ...actual,
    getLiveJobs: (opts: any) => {
      h.calls.push(opts);
      return h.transport(opts);
    },
    getLiveJobById: (id: string, isPro: boolean) => h.byId(id, isPro),
  };
};
export const sessionMock = async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
  return { ...actual, getAuthUser: async () => h.user, getUserPreferences: async () => (await h.prefs) ?? null };
};
export const billingMock = () => ({
  getProAccessStatus: async () => ({ isPro: h.isPro, isDefinitive: true }),
});
export const trackerMock = async () => {
  const actual = await vi.importActual<typeof import("@/lib/tracker/storage")>("@/lib/tracker/storage");
  return {
    ...actual,
    getTrackedApplications: async () => h.apps,
    addApplicationToTracker: vi.fn(async () => {
      throw new Error("FIXTURE: tracker writes are not allowed in tests");
    }),
    removeApplicationFromTracker: vi.fn(),
    updateApplicationStage: vi.fn(),
    quickTrackJob: vi.fn(),
  };
};
export const resumeStorageMock = async () => {
  const actual = await vi.importActual<typeof import("@/lib/resume/storage")>("@/lib/resume/storage");
  return { ...actual, getCandidateProfile: async () => null };
};
export const navigationMock = () => ({
  useRouter: () => h.router,
  usePathname: () => "/jobs",
  useSearchParams: () => new URLSearchParams(window.location.search),
});
export const funnelMock = () => ({ trackFunnelEvent: vi.fn() });
export const supabaseClientMock = () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => ({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: () => {
      throw new Error("FIXTURE: no database access from the jobs page tests");
    },
  }),
});

// --- browser stand-ins ---
type IOEntry = { cb: IntersectionObserverCallback; els: Element[]; disconnected: boolean };
export const io = {
  instances: [] as IOEntry[],
  /** Fires every live observer that watches the sentinel, as the browser does when it scrolls into view. */
  enter(userInput = true) {
    if (userInput) window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    for (const inst of io.instances) {
      if (inst.disconnected) continue;
      inst.cb(
        inst.els.map((target) => ({ isIntersecting: true, target }) as unknown as IntersectionObserverEntry),
        {} as IntersectionObserver
      );
    }
  },
  get live() {
    return io.instances.filter((i) => !i.disconnected).length;
  },
};

export function installBrowserStandIns() {
  class FakeIO {
    entry: IOEntry;
    constructor(cb: IntersectionObserverCallback) {
      this.entry = { cb, els: [], disconnected: false };
      io.instances.push(this.entry);
    }
    observe(el: Element) {
      this.entry.els.push(el);
    }
    unobserve() {}
    disconnect() {
      this.entry.disconnected = true;
    }
    takeRecords() {
      return [];
    }
  }
  (globalThis as any).IntersectionObserver = FakeIO;
  window.matchMedia = ((q: string) => {
    const min = /min-width:\s*(\d+)/.exec(q);
    const max = /max-width:\s*(\d+)/.exec(q);
    const width = h.desktop ? 1280 : 390;
    const matches = min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : q.includes("reduce") ? true : false;
    return {
      matches,
      media: q,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
  window.scrollTo = (() => {}) as any;
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (window as any).IS_REACT_ACT_ENVIRONMENT = true;
}

export async function flush(times = 12) {
  for (let i = 0; i < times; i++) await act(async () => await Promise.resolve());
}

export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const NOW = Date.now();
/** Synthetic FIXTURE job. Every value is invented; company/domain/logo are fixture-only strings. */
export function fixtureJob(i: number, over: Partial<LiveJob> = {}): LiveJob {
  return {
    id: `fx-${i}`,
    title: `Fixture Analyst ${i}`,
    company: `Fixturecorp ${i}`,
    location: "Bengaluru, Karnataka, India",
    date: new Date(NOW - i * 3600_000).toISOString(),
    postedAt: new Date(NOW - i * 3600_000).toISOString(),
    salary: "₹12L - ₹18L",
    category: "engineering",
    remote: false,
    country: "IN",
    type: "full-time",
    directSource: true,
    applyUrl: `https://careers.fixture-${i}.invalid/apply`,
    companyDomain: `fixture-${i}.invalid`,
    description: "FIXTURE description.",
    skills: ["SQL"],
    ...over,
  };
}

export function page(jobs: LiveJob[], hasNextPage: boolean, totalCount = 100): GetJobsResult {
  return { jobs, totalCount, hasNextPage, nextCursor: null };
}

export const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => from + k);
