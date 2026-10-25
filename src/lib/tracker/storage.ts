import { TrackedApplication, ApplicationStage } from "./types";
import { createClient } from "../supabase/client";
import { sanitizeTrackerApplicationRecord, stripHtmlAndExecutableMarkup } from "../security/xss";

export const GUEST_STORAGE_KEY = "careermonke_applications_guest";
export const LEGACY_STORAGE_KEY = "careermonke_applications_tracker";
export const LEGACY_FALLBACK_KEY = "careermonke_applications";

export function getScopedTrackerStorageKey(userId?: string | null): string {
  if (userId && userId.trim()) {
    return `careermonke_applications_${userId.trim()}`;
  }
  return GUEST_STORAGE_KEY;
}

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

// In-memory state tracking active owner, generation tokens, and caches
let activeTrackerOwnerId: string | null = null;
let activeTrackerGenToken = 0;
let cachedApplications: { data: TrackedApplication[]; timestamp: number; ownerId: string | null; token: number } | null = null;
let inFlightApplicationsPromise: { promise: Promise<TrackedApplication[]>; ownerId: string | null; token: number } | null = null;

const APPS_CACHE_TTL_MS = 30000; // 30 seconds memoization to prevent duplicate queries

/**
 * Completely clears in-memory state and invalidates any in-flight asynchronous operations
 * on user sign-out or account switch.
 */
export function clearTrackerMemoryState(): void {
  activeTrackerOwnerId = null;
  activeTrackerGenToken++;
  cachedApplications = null;
  inFlightApplicationsPromise = null;
}

export function invalidateTrackedApplicationsCache(): void {
  cachedApplications = null;
  inFlightApplicationsPromise = null;
}

/**
 * Loads applications from user-scoped localStorage, then fetches & syncs with Supabase if logged in.
 * Memoized and deduplicated by active user to prevent cross-account contamination.
 * Unowned legacy applications lists are strictly isolated and never read, merged, or uploaded.
 */
export async function getTrackedApplications(userId?: string | null): Promise<TrackedApplication[]> {
  let resolvedUserId = userId;
  if (resolvedUserId === undefined && typeof window !== "undefined") {
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        resolvedUserId = session.user.id;
      }
    } catch {}
  }

  // If still undefined and an active owner was previously established, maintain it:
  if (resolvedUserId === undefined && activeTrackerOwnerId !== null) {
    resolvedUserId = activeTrackerOwnerId;
  }

  const currentOwnerId = resolvedUserId ? resolvedUserId.trim() : null;

  // Detect account switch or first initialization:
  if (activeTrackerOwnerId !== currentOwnerId) {
    activeTrackerOwnerId = currentOwnerId;
    activeTrackerGenToken++;
    cachedApplications = null;
    inFlightApplicationsPromise = null;
  }

  const currentToken = activeTrackerGenToken;
  const now = Date.now();

  if (
    cachedApplications &&
    cachedApplications.ownerId === currentOwnerId &&
    cachedApplications.token === currentToken &&
    now - cachedApplications.timestamp < APPS_CACHE_TTL_MS
  ) {
    return cachedApplications.data;
  }

  if (
    inFlightApplicationsPromise &&
    inFlightApplicationsPromise.ownerId === currentOwnerId &&
    inFlightApplicationsPromise.token === currentToken
  ) {
    return inFlightApplicationsPromise.promise;
  }

  const fetchPromise = (async () => {
    try {
      let localApps: TrackedApplication[] = [];
      const storageKey = getScopedTrackerStorageKey(currentOwnerId);

      if (typeof window !== "undefined") {
        try {
          const stored = localStorage.getItem(storageKey);
          if (stored) {
            localApps = JSON.parse(stored);
          }
        } catch (e) {
          console.warn("Failed to load local tracker applications", e);
        }
      }

      if (currentOwnerId) {
        try {
          const supabase = createClient();
          const queryPromise = supabase
            .from("applications")
            .select("*")
            .eq("user_id", currentOwnerId)
            .order("updated_at", { ascending: false });

          const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
            setTimeout(() => resolve({ data: null, error: new Error("Applications query timeout") }), 4000)
          );

          const { data, error } = await Promise.race([queryPromise, timeoutPromise]);

          // Stale check: if user switched while query was in-flight, discard immediately!
          if (activeTrackerGenToken !== currentToken || activeTrackerOwnerId !== currentOwnerId) {
            return [];
          }

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

            // Merge local apps for THIS OWNER ONLY with remote apps
            const mergedMap = new Map<string, TrackedApplication>();
            localApps.forEach((a) => mergedMap.set(a.id, a));
            remoteApps.forEach((remote) => {
              const local = mergedMap.get(remote.id);
              mergedMap.set(remote.id, {
                ...remote,
                jobId: remote.jobId || local?.jobId,
              });
            });

            const finalApps = Array.from(mergedMap.values());
            saveToLocalStorage(finalApps, currentOwnerId);
            cachedApplications = { data: finalApps, timestamp: Date.now(), ownerId: currentOwnerId, token: currentToken };
            return finalApps;
          }
        } catch (err) {
          // Offline or error
        }
      }

      // Stale check before returning local apps
      if (activeTrackerGenToken !== currentToken || activeTrackerOwnerId !== currentOwnerId) {
        return [];
      }

      cachedApplications = { data: localApps, timestamp: Date.now(), ownerId: currentOwnerId, token: currentToken };
      return localApps;
    } finally {
      if (inFlightApplicationsPromise?.token === currentToken) {
        inFlightApplicationsPromise = null;
      }
    }
  })();

  inFlightApplicationsPromise = { promise: fetchPromise, ownerId: currentOwnerId, token: currentToken };
  return fetchPromise;
}

/**
 * Saves applications to owner-scoped local storage
 */
function saveToLocalStorage(apps: TrackedApplication[], ownerId?: string | null) {
  const targetOwnerId = ownerId !== undefined ? (ownerId?.trim() || null) : activeTrackerOwnerId;
  const storageKey = getScopedTrackerStorageKey(targetOwnerId);
  invalidateTrackedApplicationsCache();
  cachedApplications = {
    data: apps,
    timestamp: Date.now(),
    ownerId: targetOwnerId,
    token: activeTrackerGenToken,
  };

  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(storageKey, JSON.stringify(apps));
      window.dispatchEvent(new Event("careermonke_tracker_updated"));
    } catch (e) {
      console.warn("Failed to save applications locally", e);
    }
  }
}

function extractJobId(entity: { jobId?: string | null; id?: string | null; stage?: string }): string | undefined {
  if (entity.jobId?.trim()) return entity.jobId.trim();
  if (!entity.stage && entity.id?.trim()) return entity.id.trim();
  return undefined;
}

/**
 * Matches a tracked application against a target job or application record.
 * When BOTH records have non-empty job IDs, compares IDs only.
 * Company and title fallback is only used if at least one record lacks a job ID.
 */
export function isMatchingTrackerJob(
  app: { jobId?: string | null; id?: string | null; stage?: string; company?: string | null; title?: string | null },
  target: { jobId?: string | null; id?: string | null; stage?: string; company?: string | null; title?: string | null }
): boolean {
  const appJobId = extractJobId(app);
  const targetJobId = extractJobId(target);

  // When BOTH records have non-empty job IDs, compare IDs ONLY:
  if (appJobId && targetJobId) {
    return appJobId === targetJobId;
  }

  // Fallback to company and title ONLY if at least one record lacks a job ID:
  if (app.company && target.company && app.title && target.title) {
    return (
      app.company.trim().toLowerCase() === target.company.trim().toLowerCase() &&
      app.title.trim().toLowerCase() === target.title.trim().toLowerCase()
    );
  }

  return false;
}

/**
 * Adds a new job to the tracker
 */
export async function addApplicationToTracker(
  app: Omit<TrackedApplication, "id" | "createdAt" | "updatedAt">,
  userId?: string
): Promise<TrackedApplication> {
  const currentOwner = userId?.trim() || activeTrackerOwnerId;
  const writeToken = activeTrackerGenToken;
  const appId = generateUUID();
  const sanitizedInput = sanitizeTrackerApplicationRecord(app);
  const newApp: TrackedApplication = {
    ...sanitizedInput,
    id: appId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const current = await getTrackedApplications(currentOwner);
  if (activeTrackerGenToken !== writeToken) {
    return newApp;
  }

  // Check if job already tracked using strict ID matching when available
  const existingIdx = current.findIndex((a) => isMatchingTrackerJob(a, app));

  let targetApp: TrackedApplication;
  let updatedList: TrackedApplication[];
  if (existingIdx >= 0) {
    const existing = current[existingIdx];
    // Preserve existing ID, createdAt, notes (if not explicitly updated), and existing appliedAt/followUpAt
    targetApp = {
      ...existing,
      stage: app.stage,
      notes: app.notes !== undefined && app.notes !== "" ? app.notes : existing.notes,
      appliedAt: app.stage === "applied" ? (existing.appliedAt || new Date().toISOString()) : existing.appliedAt,
      followUpAt: app.followUpAt !== undefined ? app.followUpAt : existing.followUpAt,
      updatedAt: new Date().toISOString(),
    };
    current[existingIdx] = targetApp;
    updatedList = current;
  } else {
    targetApp = newApp;
    updatedList = [newApp, ...current];
  }

  saveToLocalStorage(updatedList, currentOwner);

  // Sync to Supabase in background
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user || (await supabase.auth.getUser()).data.user;
    if (user && user.id === currentOwner && activeTrackerGenToken === writeToken) {
      const dbJobId = isValidUUID(targetApp.jobId) ? targetApp.jobId : null;
      const { error } = await supabase.from("applications").upsert({
        id: targetApp.id,
        user_id: user.id,
        job_id: dbJobId,
        company: targetApp.company,
        title: targetApp.title,
        location: targetApp.location || null,
        salary_text: targetApp.salaryText || null,
        apply_url: targetApp.applyUrl || null,
        stage: targetApp.stage,
        notes: targetApp.notes || null,
        applied_at: targetApp.appliedAt || null,
        follow_up_at: targetApp.followUpAt || null,
        updated_at: targetApp.updatedAt,
      });
      if (error) {
        console.warn("Failed to sync application to Supabase:", error);
      }
    }
  } catch (e) {}

  return targetApp;
}

/**
 * Updates stage for an application
 */
export async function updateApplicationStage(id: string, stage: ApplicationStage, userId?: string) {
  const currentOwner = userId?.trim() || activeTrackerOwnerId;
  const writeToken = activeTrackerGenToken;
  const current = await getTrackedApplications(currentOwner);
  if (activeTrackerGenToken !== writeToken) return;

  const target = current.find((a) => a.id === id);
  if (!target) return;

  target.stage = stage;
  target.updatedAt = new Date().toISOString();
  if (stage === "applied" && !target.appliedAt) {
    target.appliedAt = new Date().toISOString();
  }

  saveToLocalStorage(current, currentOwner);

  // Supabase sync
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user;
    if (user && user.id === currentOwner && activeTrackerGenToken === writeToken) {
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
export async function updateApplicationNotes(id: string, notes: string, followUpAt?: string, userId?: string) {
  const currentOwner = userId?.trim() || activeTrackerOwnerId;
  const writeToken = activeTrackerGenToken;
  const current = await getTrackedApplications(currentOwner);
  if (activeTrackerGenToken !== writeToken) return;

  const target = current.find((a) => a.id === id);
  if (!target) return;

  target.notes = notes;
  if (followUpAt !== undefined) target.followUpAt = followUpAt;
  target.updatedAt = new Date().toISOString();

  saveToLocalStorage(current, currentOwner);

  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user;
    if (user && user.id === currentOwner && activeTrackerGenToken === writeToken) {
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
export async function deleteApplicationFromTracker(id: string, userId?: string) {
  const currentOwner = userId?.trim() || activeTrackerOwnerId;
  const writeToken = activeTrackerGenToken;
  const current = await getTrackedApplications(currentOwner);
  if (activeTrackerGenToken !== writeToken) return;

  const filtered = current.filter((a) => a.id !== id);
  saveToLocalStorage(filtered, currentOwner);

  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user;
    if (user && user.id === currentOwner && activeTrackerGenToken === writeToken) {
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
export async function removeApplicationFromTracker(jobIdOrId: string, userId?: string) {
  const currentOwner = userId?.trim() || activeTrackerOwnerId;
  const writeToken = activeTrackerGenToken;
  const current = await getTrackedApplications(currentOwner);
  if (activeTrackerGenToken !== writeToken) return;

  const target = current.find((a) => a.jobId === jobIdOrId || a.id === jobIdOrId);
  const filtered = current.filter((a) => a.jobId !== jobIdOrId && a.id !== jobIdOrId);

  saveToLocalStorage(filtered, currentOwner);

  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user;
    if (user && target && user.id === currentOwner && activeTrackerGenToken === writeToken) {
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
