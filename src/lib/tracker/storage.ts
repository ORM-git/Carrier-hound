import { TrackedApplication, ApplicationStage } from "./types";
import { createClient } from "../supabase/client";
import { sanitizeTrackerApplicationRecord, stripHtmlAndExecutableMarkup } from "../security/xss";

const LOCAL_STORAGE_KEY = "careermonke_applications_tracker";

function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function isValidUUID(str?: string | null): boolean {
  if (!str) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

let inFlightApplicationsPromise: Promise<TrackedApplication[]> | null = null;
let cachedApplications: { data: TrackedApplication[]; timestamp: number } | null = null;
const APPS_CACHE_TTL_MS = 30000; // 30 seconds memoization to prevent duplicate calls

export function invalidateTrackedApplicationsCache() {
  cachedApplications = null;
  inFlightApplicationsPromise = null;
}

/**
 * Loads applications from localStorage, then fetches & syncs with Supabase if logged in.
 * Memoized and deduplicated to prevent concurrent duplicate queries.
 */
export async function getTrackedApplications(userId?: string): Promise<TrackedApplication[]> {
  const now = Date.now();
  if (cachedApplications && now - cachedApplications.timestamp < APPS_CACHE_TTL_MS) {
    return cachedApplications.data;
  }

  if (inFlightApplicationsPromise) {
    return inFlightApplicationsPromise;
  }

  inFlightApplicationsPromise = (async () => {
    try {
      let localApps: TrackedApplication[] = [];

      if (typeof window !== "undefined") {
        try {
          const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
          if (stored) {
            localApps = JSON.parse(stored);
          }
        } catch (e) {
          console.warn("Failed to load local tracker applications", e);
        }
      }

      // Try fetching from Supabase if user is authenticated
      try {
        const supabase = createClient();
        let resolvedUserId = userId;

    if (!resolvedUserId) {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        resolvedUserId = session.user.id;
      } else {
        const { data: { user } } = await supabase.auth.getUser();
        resolvedUserId = user?.id;
      }
    }

    if (resolvedUserId) {
      const queryPromise = supabase
        .from("applications")
        .select("*")
        .eq("user_id", resolvedUserId)
        .order("updated_at", { ascending: false });

      const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: new Error("Applications query timeout") }), 4000)
      );

      const { data, error } = await Promise.race([queryPromise, timeoutPromise]);

      if (!error && data && data.length > 0) {
        const remoteApps: TrackedApplication[] = data.map((row: any) => ({
          id: row.id,
          jobId: row.job_id,
          company: row.company,
          title: row.title,
          location: row.location,
          salaryText: row.salary_text,
          applyUrl: row.apply_url,
          stage: row.stage as ApplicationStage,
          notes: row.notes,
          appliedAt: row.applied_at,
          followUpAt: row.follow_up_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));

        // Merge local with remote (remote takes priority)
        const mergedMap = new Map<string, TrackedApplication>();
        localApps.forEach((a) => mergedMap.set(a.id, a));
        remoteApps.forEach((a) => mergedMap.set(a.id, a));

        const finalApps = Array.from(mergedMap.values());
        saveToLocalStorage(finalApps);
        cachedApplications = { data: finalApps, timestamp: Date.now() };
        return finalApps;
      }
    }
  } catch (err) {
    // Offline or guest mode
  }

      cachedApplications = { data: localApps, timestamp: Date.now() };
      return localApps;
    } finally {
      inFlightApplicationsPromise = null;
    }
  })();

  return inFlightApplicationsPromise;
}

/**
 * Saves applications to local storage
 */
function saveToLocalStorage(apps: TrackedApplication[]) {
  invalidateTrackedApplicationsCache();
  cachedApplications = { data: apps, timestamp: Date.now() };
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(apps));
      window.dispatchEvent(new Event("careermonke_tracker_updated"));
    } catch (e) {
      console.warn("Failed to save applications locally", e);
    }
  }
}

/**
 * Adds a new job to the tracker
 */
export async function addApplicationToTracker(
  app: Omit<TrackedApplication, "id" | "createdAt" | "updatedAt">
): Promise<TrackedApplication> {
  const appId = generateUUID();
  const sanitizedInput = sanitizeTrackerApplicationRecord(app);
  const newApp: TrackedApplication = {
    ...sanitizedInput,
    id: appId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const current = await getTrackedApplications();
  // Check if job already tracked
  const existingIdx = current.findIndex(
    (a) => (app.jobId && a.jobId === app.jobId) || (a.company === app.company && a.title === app.title)
  );

  let updatedList: TrackedApplication[];
  if (existingIdx >= 0) {
    // Update stage if already present
    current[existingIdx] = {
      ...current[existingIdx],
      stage: app.stage,
      updatedAt: new Date().toISOString(),
    };
    updatedList = current;
  } else {
    updatedList = [newApp, ...current];
  }

  saveToLocalStorage(updatedList);

  // Sync to Supabase in background
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user || (await supabase.auth.getUser()).data.user;
    if (user) {
      const dbJobId = isValidUUID(newApp.jobId) ? newApp.jobId : null;
      const { error } = await supabase.from("applications").upsert({
        id: newApp.id,
        user_id: user.id,
        job_id: dbJobId,
        company: newApp.company,
        title: newApp.title,
        location: newApp.location || null,
        salary_text: newApp.salaryText || null,
        apply_url: newApp.applyUrl || null,
        stage: newApp.stage,
        notes: newApp.notes || null,
        applied_at: newApp.appliedAt || null,
        follow_up_at: newApp.followUpAt || null,
        updated_at: new Date().toISOString(),
      });
      if (error) {
        console.warn("Failed to sync application to Supabase:", error);
      }
    }
  } catch (e) {}

  return newApp;
}

/**
 * Updates stage for an application
 */
export async function updateApplicationStage(id: string, stage: ApplicationStage) {
  const current = await getTrackedApplications();
  const target = current.find((a) => a.id === id);
  if (!target) return;

  target.stage = stage;
  target.updatedAt = new Date().toISOString();
  if (stage === "applied" && !target.appliedAt) {
    target.appliedAt = new Date().toISOString();
  }

  saveToLocalStorage(current);

  // Supabase sync
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user;
    if (user) {
      await supabase
        .from("applications")
        .update({
          stage,
          applied_at: target.appliedAt || null,
          updated_at: target.updatedAt,
        })
        .eq("id", id)
        .eq("user_id", user.id);
    }
  } catch (e) {}
}

/**
 * Updates notes for an application
 */
export async function updateApplicationNotes(id: string, notes: string, followUpAt?: string) {
  const current = await getTrackedApplications();
  const target = current.find((a) => a.id === id);
  if (!target) return;

  target.notes = notes;
  if (followUpAt !== undefined) target.followUpAt = followUpAt;
  target.updatedAt = new Date().toISOString();

  saveToLocalStorage(current);

  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user;
    if (user) {
      await supabase
        .from("applications")
        .update({
          notes,
          follow_up_at: target.followUpAt || null,
          updated_at: target.updatedAt,
        })
        .eq("id", id)
        .eq("user_id", user.id);
    }
  } catch (e) {}
}

/**
 * Deletes an application from the tracker
 */
export async function deleteApplicationFromTracker(id: string) {
  const current = await getTrackedApplications();
  const filtered = current.filter((a) => a.id !== id);

  saveToLocalStorage(filtered);

  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user;
    if (user) {
      await supabase
        .from("applications")
        .delete()
        .eq("id", id)
        .eq("user_id", user.id);
    }
  } catch (e) {}
}

/**
 * Removes an application from the tracker by jobId or id
 */
export async function removeApplicationFromTracker(jobIdOrId: string) {
  const current = await getTrackedApplications();
  const target = current.find((a) => a.jobId === jobIdOrId || a.id === jobIdOrId);
  const filtered = current.filter((a) => a.jobId !== jobIdOrId && a.id !== jobIdOrId);

  saveToLocalStorage(filtered);

  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user;
    if (user && target) {
      await supabase
        .from("applications")
        .delete()
        .eq("id", target.id)
        .eq("user_id", user.id);
    }
  } catch (e) {}
}

/**
 * Quick helper to track a job in 1 click
 */
export async function quickTrackJob(
  job: {
    id?: string;
    title: string;
    company: string;
    location?: string;
    salary_text?: string;
    apply_url?: string;
  },
  stage: ApplicationStage = "saved"
): Promise<TrackedApplication> {
  return addApplicationToTracker({
    jobId: job.id,
    company: job.company,
    title: job.title,
    location: job.location,
    salaryText: job.salary_text,
    applyUrl: job.apply_url,
    stage,
    notes: "",
    appliedAt: stage === "applied" ? new Date().toISOString() : undefined,
  });
}
