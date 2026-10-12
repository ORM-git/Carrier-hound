import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getSupabaseAdmin } from "./auth";

export interface PageViewPayload {
  path: string;
  userId?: string | null;
  referrer?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
  createdAt?: string;
}

export interface PageViewRecord {
  id?: string;
  path: string;
  user_id?: string | null;
  referrer?: string | null;
  ip_hash?: string | null;
  user_agent?: string | null;
  created_at: string;
}

export interface AnalyticsStats {
  rangeDays: number;
  totalViews: number;
  uniqueVisitors: number;
  totalUsers: number;
  totalProUsers: number;
  topPages: Array<{
    path: string;
    views: number;
    uniqueVisitors: number;
    percentage: number;
  }>;
  dailyViews: Array<{
    date: string;
    views: number;
    uniqueVisitors: number;
  }>;
  recentSignups: Array<{
    id: string;
    email: string;
    createdAt: string;
    lastSignInAt?: string;
    isPro: boolean;
    isBlocked: boolean;
  }>;
}

export interface UserManagementItem {
  id: string;
  email: string;
  createdAt: string;
  lastSignInAt?: string;
  isPro: boolean;
  isBlocked: boolean;
  totalViews: number;
  blockedAt?: string;
  blockedReason?: string;
}

const FALLBACK_DIR = path.resolve(process.cwd(), "data");
const FALLBACK_FILE = path.resolve(FALLBACK_DIR, "page_views_fallback.json");

// In-memory buffer to supplement storage
let inMemoryViews: PageViewRecord[] = [];

function getFallbackRecords(): PageViewRecord[] {
  try {
    if (!fs.existsSync(FALLBACK_DIR)) {
      fs.mkdirSync(FALLBACK_DIR, { recursive: true });
    }
    if (fs.existsSync(FALLBACK_FILE)) {
      const content = fs.readFileSync(FALLBACK_FILE, "utf-8");
      return JSON.parse(content);
    }
  } catch (_) {}
  return [];
}

function saveFallbackRecord(record: PageViewRecord) {
  try {
    inMemoryViews.push(record);
    if (!fs.existsSync(FALLBACK_DIR)) {
      fs.mkdirSync(FALLBACK_DIR, { recursive: true });
    }
    const current = getFallbackRecords();
    current.push(record);
    // Keep max 5,000 recent fallback records
    const trimmed = current.slice(-5000);
    fs.writeFileSync(FALLBACK_FILE, JSON.stringify(trimmed, null, 2), "utf-8");
  } catch (_) {}
}

/**
 * Lightweight, non-blocking fire-and-forget page view recorder.
 */
export async function recordPageView(payload: PageViewPayload): Promise<void> {
  if (!payload.path || typeof payload.path !== "string") return;

  const record: PageViewRecord = {
    path: payload.path,
    user_id: payload.userId || null,
    referrer: payload.referrer || null,
    ip_hash: payload.ipHash || null,
    user_agent: payload.userAgent || null,
    created_at: payload.createdAt || new Date().toISOString(),
  };

  // Always keep in fallback buffer
  saveFallbackRecord(record);

  try {
    const admin = getSupabaseAdmin();
    const { error } = await admin.from("page_views").insert(record);
    if (error && error.code !== "PGRST205") {
      // Table exists but insert error
      console.warn("[analytics] Insert error:", error.message);
    }
  } catch (_) {
    // Fail silently
  }
}

/**
 * Returns analytics overview data for 7 or 30 days.
 */
export async function getAnalyticsStats(rangeDays: 7 | 30 = 7): Promise<AnalyticsStats> {
  const admin = getSupabaseAdmin();
  const now = new Date();
  const cutoff = new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  // 1. Fetch page views from Supabase or fallback
  let allViews: PageViewRecord[] = [];

  try {
    const { data, error } = await admin
      .from("page_views")
      .select("*")
      .gte("created_at", cutoffIso)
      .order("created_at", { ascending: false });

    if (!error && Array.isArray(data) && data.length > 0) {
      allViews = data;
    } else {
      // Use fallback data
      const fallback = getFallbackRecords();
      allViews = fallback.filter((r) => r.created_at >= cutoffIso);
    }
  } catch (_) {
    const fallback = getFallbackRecords();
    allViews = fallback.filter((r) => r.created_at >= cutoffIso);
  }

  // Deduplicate and combine with any recent in-memory views not yet written
  const seenIds = new Set(allViews.map((v) => `${v.path}_${v.created_at}_${v.ip_hash}`));
  for (const im of inMemoryViews) {
    if (im.created_at >= cutoffIso) {
      const key = `${im.path}_${im.created_at}_${im.ip_hash}`;
      if (!seenIds.has(key)) {
        seenIds.add(key);
        allViews.push(im);
      }
    }
  }

  // 2. Fetch users and subscriptions
  let totalUsers = 0;
  let totalProUsers = 0;
  let recentSignups: AnalyticsStats["recentSignups"] = [];

  try {
    const { data: usersData } = await admin.auth.admin.listUsers();
    const { data: subsData } = await admin.from("subscriptions").select("*");

    const activeSubs = new Set(
      (subsData || [])
        .filter((s: any) => s.status === "active" && (!s.current_period_end || new Date(s.current_period_end) > now))
        .map((s: any) => s.user_id)
    );

    const users = usersData?.users || [];
    totalUsers = users.length;

    // Sort users by created_at desc
    const sortedUsers = [...users].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    totalProUsers = sortedUsers.filter(
      (u) => activeSubs.has(u.id) || u.user_metadata?.is_pro === true
    ).length;

    recentSignups = sortedUsers.slice(0, 10).map((u) => {
      const isPro = activeSubs.has(u.id) || u.user_metadata?.is_pro === true;
      const isBlocked =
        Boolean(u.banned_until && new Date(u.banned_until) > now) ||
        u.user_metadata?.is_blocked === true;

      return {
        id: u.id,
        email: u.email || "anonymous",
        createdAt: u.created_at,
        lastSignInAt: u.last_sign_in_at,
        isPro,
        isBlocked,
      };
    });
  } catch (err) {
    console.warn("[analytics] User stats fetch failed:", err);
  }

  // 3. Compute Metrics
  const totalViews = allViews.length;
  const uniqueVisitorSet = new Set<string>();
  const pageMap = new Map<string, { views: number; uniqueVisitors: Set<string> }>();
  const dayMap = new Map<string, { views: number; uniqueVisitors: Set<string> }>();

  // Pre-seed dayMap with all dates in the range
  for (let i = rangeDays - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().split("T")[0];
    dayMap.set(dateStr, { views: 0, uniqueVisitors: new Set() });
  }

  for (const view of allViews) {
    const visitorKey = view.user_id || view.ip_hash || "unknown_visitor";
    uniqueVisitorSet.add(visitorKey);

    // Page stats
    const normalizedPath = view.path || "/";
    if (!pageMap.has(normalizedPath)) {
      pageMap.set(normalizedPath, { views: 0, uniqueVisitors: new Set() });
    }
    const pageEntry = pageMap.get(normalizedPath)!;
    pageEntry.views++;
    pageEntry.uniqueVisitors.add(visitorKey);

    // Daily stats
    const dateStr = (view.created_at || "").split("T")[0];
    if (dayMap.has(dateStr)) {
      const dayEntry = dayMap.get(dateStr)!;
      dayEntry.views++;
      dayEntry.uniqueVisitors.add(visitorKey);
    }
  }

  // Top Pages
  const topPages = Array.from(pageMap.entries())
    .map(([pathName, stats]) => ({
      path: pathName,
      views: stats.views,
      uniqueVisitors: stats.uniqueVisitors.size,
      percentage: totalViews > 0 ? Math.round((stats.views / totalViews) * 100) : 0,
    }))
    .sort((a, b) => b.views - a.views);

  // Daily views array
  const dailyViews = Array.from(dayMap.entries()).map(([date, stats]) => ({
    date,
    views: stats.views,
    uniqueVisitors: stats.uniqueVisitors.size,
  }));

  return {
    rangeDays,
    totalViews,
    uniqueVisitors: uniqueVisitorSet.size,
    totalUsers,
    totalProUsers,
    topPages,
    dailyViews,
    recentSignups,
  };
}

/**
 * Returns all registered users with activity, Pro status, and moderation state.
 */
export async function getUsersManagementList(
  searchQuery?: string
): Promise<UserManagementItem[]> {
  const admin = getSupabaseAdmin();
  const now = new Date();

  // 1. Fetch users from Supabase Auth
  const { data: usersData, error: usersError } = await admin.auth.admin.listUsers();
  if (usersError || !usersData?.users) {
    throw new Error(usersError?.message || "Failed to list users");
  }

  // 2. Fetch subscriptions
  const { data: subsData } = await admin.from("subscriptions").select("*");
  const activeSubs = new Set(
    (subsData || [])
      .filter((s: any) => s.status === "active" && (!s.current_period_end || new Date(s.current_period_end) > now))
      .map((s: any) => s.user_id)
  );

  // 3. Fetch blocked users from blocked_users table
  const blockedUsersMap = new Map<string, { blockedAt?: string; reason?: string }>();
  try {
    const { data: blockedRows } = await admin.from("blocked_users").select("*");
    if (Array.isArray(blockedRows)) {
      for (const b of blockedRows) {
        blockedUsersMap.set(b.user_id, {
          blockedAt: b.blocked_at,
          reason: b.reason,
        });
      }
    }
  } catch (_) {}

  // 4. Fetch page views count per user
  const userViewsCount = new Map<string, number>();

  try {
    const { data: viewsData } = await admin.from("page_views").select("user_id");
    if (Array.isArray(viewsData)) {
      for (const row of viewsData) {
        if (row.user_id) {
          userViewsCount.set(row.user_id, (userViewsCount.get(row.user_id) || 0) + 1);
        }
      }
    }
  } catch (_) {
    // Check fallback
    const fallback = getFallbackRecords();
    for (const row of fallback) {
      if (row.user_id) {
        userViewsCount.set(row.user_id, (userViewsCount.get(row.user_id) || 0) + 1);
      }
    }
  }

  // Include in-memory
  for (const row of inMemoryViews) {
    if (row.user_id) {
      userViewsCount.set(row.user_id, (userViewsCount.get(row.user_id) || 0) + 1);
    }
  }

  // 5. Construct user management items
  const query = (searchQuery || "").trim().toLowerCase();

  const userItems: UserManagementItem[] = usersData.users
    .filter((u) => {
      if (!query) return true;
      return (u.email || "").toLowerCase().includes(query);
    })
    .map((u) => {
      const isPro = activeSubs.has(u.id) || u.user_metadata?.is_pro === true;
      const blockedRecord = blockedUsersMap.get(u.id);
      const isBlocked =
        Boolean(u.banned_until && new Date(u.banned_until) > now) ||
        u.user_metadata?.is_blocked === true ||
        Boolean(blockedRecord);

      return {
        id: u.id,
        email: u.email || "anonymous",
        createdAt: u.created_at,
        lastSignInAt: u.last_sign_in_at,
        isPro,
        isBlocked,
        totalViews: userViewsCount.get(u.id) || 0,
        blockedAt: blockedRecord?.blockedAt || u.user_metadata?.blocked_at,
        blockedReason: blockedRecord?.reason || u.user_metadata?.blocked_reason,
      };
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return userItems;
}

/**
 * Returns timeline activity logs for a specific user ID.
 */
export async function getUserActivityLogs(userId: string): Promise<PageViewRecord[]> {
  if (!userId) return [];
  const admin = getSupabaseAdmin();

  let userLogs: PageViewRecord[] = [];

  try {
    const { data, error } = await admin
      .from("page_views")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(200);

    if (!error && Array.isArray(data)) {
      userLogs = data;
    }
  } catch (_) {}

  if (userLogs.length === 0) {
    const fallback = getFallbackRecords();
    userLogs = fallback
      .filter((r) => r.user_id === userId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 200);
  }

  return userLogs;
}

/**
 * Blocks or unblocks a user across Supabase Auth and blocked_users table.
 */
export async function setUserBlockStatus(
  userId: string,
  shouldBlock: boolean,
  reason: string = "Account suspended by administrator"
): Promise<{ success: boolean; isBlocked: boolean; error?: string }> {
  if (!userId) return { success: false, isBlocked: false, error: "Missing user ID" };

  const admin = getSupabaseAdmin();

  try {
    // 1. Fetch user to confirm existence and email
    const { data: { user }, error: fetchError } = await admin.auth.admin.getUserById(userId);
    if (fetchError || !user) {
      return { success: false, isBlocked: false, error: "User not found" };
    }

    if (shouldBlock) {
      // 1. Block in Supabase Auth (bans session tokens immediately)
      const nowIso = new Date().toISOString();
      await admin.auth.admin.updateUserById(userId, {
        ban_duration: "876000h", // 100 years
        user_metadata: {
          ...user.user_metadata,
          is_blocked: true,
          blocked_at: nowIso,
          blocked_reason: reason,
        },
      });

      // 2. Insert/upsert into blocked_users table
      try {
        await admin.from("blocked_users").upsert({
          user_id: userId,
          email: user.email || "unknown",
          reason,
          blocked_by: "admin",
          blocked_at: nowIso,
        });
      } catch (_) {}

      return { success: true, isBlocked: true };
    } else {
      // 1. Unblock in Supabase Auth
      await admin.auth.admin.updateUserById(userId, {
        ban_duration: "none",
        user_metadata: {
          ...user.user_metadata,
          is_blocked: false,
          blocked_at: null,
          blocked_reason: null,
        },
      });

      // 2. Remove from blocked_users table
      try {
        await admin.from("blocked_users").delete().eq("user_id", userId);
      } catch (_) {}

      return { success: true, isBlocked: false };
    }
  } catch (err: any) {
    return {
      success: false,
      isBlocked: !shouldBlock,
      error: err?.message || "Failed to update block status",
    };
  }
}
