import { getSupabaseAdmin, ADMIN_EMAIL } from "./auth";

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
  totalViews: number | null;
  blockedAt?: string;
  blockedReason?: string;
}

export interface PaginatedUsersResult {
  users: UserManagementItem[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
  searchNotice?: string | null;
}

// In-memory buffer to supplement storage (Edge/Worker safe, max 5,000 records)
let inMemoryViews: PageViewRecord[] = [];

export function getFallbackRecords(): PageViewRecord[] {
  return inMemoryViews;
}

function saveFallbackRecord(record: PageViewRecord) {
  inMemoryViews.push(record);
  if (inMemoryViews.length > 5000) {
    inMemoryViews = inMemoryViews.slice(-5000);
  }
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

export const ADMIN_USERS_PAGE_CAP = 200;
export const ADMIN_USERS_PER_PAGE = 50;
export const DB_CHUNK_SIZE = 1000;
export const DB_SUBSCRIPTIONS_CHUNK_CAP = 100; // max 100,000 subscriptions
export const DB_BLOCKED_USERS_CHUNK_CAP = 100; // max 100,000 blocked users
export const DB_PAGE_VIEWS_CHUNK_CAP = 50; // max 50,000 page views

/**
 * Paginates admin.auth.admin.listUsers until a short page (< perPage) is returned.
 * Protects against unbounded loops with a hard cap of ADMIN_USERS_PAGE_CAP (200 pages).
 * Throws an error if the cap is reached without completing the list.
 */
export async function fetchAllAdminUsers(
  adminClient: any,
  options?: { perPage?: number; maxPages?: number }
): Promise<any[]> {
  const perPage = options?.perPage ?? ADMIN_USERS_PER_PAGE;
  const maxPages = options?.maxPages ?? ADMIN_USERS_PAGE_CAP;
  const allUsers: any[] = [];
  let page = 1;

  while (page <= maxPages) {
    const { data, error } = await adminClient.auth.admin.listUsers({
      page,
      perPage,
    });
    if (error) {
      throw new Error(error.message || `Failed to list users on page ${page}`);
    }
    const users = data?.users || [];
    allUsers.push(...users);

    // If page is short (< perPage), we have reached the last page
    if (users.length < perPage) {
      return allUsers;
    }
    page++;
  }

  throw new Error(`Safety cap of ${maxPages} pages (${maxPages * perPage} users) exceeded while listing users.`);
}

/**
 * Paginates subscriptions table selecting only used columns: "user_id, status, current_period_end".
 * Queries in chunks of 1000 with .range(), stops when chunk < 1000 or cap is reached.
 */
export async function fetchAllSubscriptions(
  adminClient: any,
  options?: { chunkSize?: number; maxChunks?: number }
): Promise<Array<{ user_id: string; status: string; current_period_end?: string | null }>> {
  const chunkSize = options?.chunkSize ?? DB_CHUNK_SIZE;
  const maxChunks = options?.maxChunks ?? DB_SUBSCRIPTIONS_CHUNK_CAP;
  const allSubs: any[] = [];
  let chunkIndex = 0;

  while (chunkIndex < maxChunks) {
    const from = chunkIndex * chunkSize;
    const to = from + chunkSize - 1;
    const { data, error } = await adminClient
      .from("subscriptions")
      .select("user_id, status, current_period_end")
      .range(from, to);

    if (error) {
      console.warn(`[analytics] Error fetching subscriptions chunk ${chunkIndex}:`, error.message || error);
      break;
    }

    const rows = data || [];
    allSubs.push(...rows);

    if (rows.length < chunkSize) {
      break;
    }
    chunkIndex++;
  }

  return allSubs;
}

/**
 * Paginates blocked_users table selecting only used columns: "user_id, blocked_at, reason".
 * Queries in chunks of 1000 with .range(), stops when chunk < 1000 or cap is reached.
 */
export async function fetchAllBlockedUsers(
  adminClient: any,
  options?: { chunkSize?: number; maxChunks?: number }
): Promise<Array<{ user_id: string; blocked_at?: string; reason?: string }>> {
  const chunkSize = options?.chunkSize ?? DB_CHUNK_SIZE;
  const maxChunks = options?.maxChunks ?? DB_BLOCKED_USERS_CHUNK_CAP;
  const allBlocked: any[] = [];
  let chunkIndex = 0;

  while (chunkIndex < maxChunks) {
    const from = chunkIndex * chunkSize;
    const to = from + chunkSize - 1;
    const { data, error } = await adminClient
      .from("blocked_users")
      .select("user_id, blocked_at, reason")
      .range(from, to);

    if (error) {
      console.warn(`[analytics] Error fetching blocked_users chunk ${chunkIndex}:`, error.message || error);
      break;
    }

    const rows = data || [];
    allBlocked.push(...rows);

    if (rows.length < chunkSize) {
      break;
    }
    chunkIndex++;
  }

  return allBlocked;
}

/**
 * Paginates page_views table selecting only "user_id".
 * Queries in chunks of 1000 with .range() up to safe cap.
 * If cap is reached, logs a warning and returns aggregated counts from rows read so far.
 */
export async function fetchUserPageViewsCount(
  adminClient: any,
  options?: { chunkSize?: number; maxChunks?: number }
): Promise<Map<string, number>> {
  const chunkSize = options?.chunkSize ?? DB_CHUNK_SIZE;
  const maxChunks = options?.maxChunks ?? DB_PAGE_VIEWS_CHUNK_CAP;
  const userViewsCount = new Map<string, number>();
  let chunkIndex = 0;
  let hitCap = false;

  try {
    while (chunkIndex < maxChunks) {
      const from = chunkIndex * chunkSize;
      const to = from + chunkSize - 1;
      const { data, error } = await adminClient
        .from("page_views")
        .select("user_id")
        .range(from, to);

      if (error) {
        break;
      }

      const rows = data || [];
      for (const row of rows) {
        if (row.user_id) {
          userViewsCount.set(row.user_id, (userViewsCount.get(row.user_id) || 0) + 1);
        }
      }

      if (rows.length < chunkSize) {
        break;
      }
      chunkIndex++;
      if (chunkIndex === maxChunks) {
        hitCap = true;
      }
    }

    if (hitCap) {
      console.warn(
        `[analytics] Warning: page_views count query reached safe limit of ${maxChunks * chunkSize} rows; results may be truncated.`
      );
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

  return userViewsCount;
}

/**
 * Returns analytics overview data for 7 or 30 days.
 */
export async function getAnalyticsStats(
  rangeDays: 7 | 30 = 7,
  adminClient?: any
): Promise<AnalyticsStats> {
  const admin = adminClient || getSupabaseAdmin();
  const now = new Date();
  const cutoff = new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  // 1. Fetch page views from Supabase or fallback
  let allViews: PageViewRecord[] = [];

  try {
    let chunkIndex = 0;
    const maxChunks = DB_PAGE_VIEWS_CHUNK_CAP;
    let hitCap = false;

    while (chunkIndex < maxChunks) {
      const from = chunkIndex * DB_CHUNK_SIZE;
      const to = from + DB_CHUNK_SIZE - 1;
      const { data, error } = await admin
        .from("page_views")
        .select("path, created_at, ip_hash, user_id")
        .gte("created_at", cutoffIso)
        .order("created_at", { ascending: false })
        .range(from, to);

      if (error || !Array.isArray(data)) {
        break;
      }

      allViews.push(...data);

      if (data.length < DB_CHUNK_SIZE) {
        break;
      }
      chunkIndex++;
      if (chunkIndex === maxChunks) {
        hitCap = true;
      }
    }

    if (hitCap) {
      console.warn(
        `[analytics] Warning: getAnalyticsStats page_views reached safe limit of ${maxChunks * DB_CHUNK_SIZE} rows; results may be truncated.`
      );
    }

    if (allViews.length === 0) {
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
    const users = await fetchAllAdminUsers(admin);
    const subsData = await fetchAllSubscriptions(admin);

    const activeSubs = new Set(
      (subsData || [])
        .filter((s: any) => s.status === "active" && (!s.current_period_end || new Date(s.current_period_end) > now))
        .map((s: any) => s.user_id)
    );

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
  searchQuery?: string,
  adminClient?: any
): Promise<UserManagementItem[]> {
  const admin = adminClient || getSupabaseAdmin();
  const now = new Date();

  // 1. Fetch users from Supabase Auth (paginated until short page, with safety cap)
  const users = await fetchAllAdminUsers(admin);

  // 2. Fetch subscriptions (paginated in chunks of 1000, selecting only needed columns)
  const subsData = await fetchAllSubscriptions(admin);
  const activeSubs = new Set(
    (subsData || [])
      .filter((s: any) => s.status === "active" && (!s.current_period_end || new Date(s.current_period_end) > now))
      .map((s: any) => s.user_id)
  );

  // 3. Fetch blocked users from blocked_users table (paginated in chunks of 1000, selecting only needed columns)
  const blockedUsersMap = new Map<string, { blockedAt?: string; reason?: string }>();
  try {
    const blockedRows = await fetchAllBlockedUsers(admin);
    for (const b of blockedRows) {
      blockedUsersMap.set(b.user_id, {
        blockedAt: b.blocked_at,
        reason: b.reason,
      });
    }
  } catch (_) {}

  // 4. Fetch page views count per user (paginated in chunks of 1000 with safe cap)
  const userViewsCount = await fetchUserPageViewsCount(admin);

  // 5. Construct user management items
  const query = (searchQuery || "").trim().toLowerCase();

  const userItems: UserManagementItem[] = users
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
 * Performs strictly bounded server-side page reads for user management.
 * Fetches exactly one page of users natively via adminClient.auth.admin.listUsers({ page, perPage: pageSize }).
 * All supplementary data queries (subscriptions, blocked_users, page_views) are bounded strictly to
 * the user IDs present on the requested page using in-clause filters (.in('user_id', pageUserIds)).
 */
export async function getPaginatedUsersManagementList(options: {
  page: number;
  pageSize: number;
  searchQuery?: string;
  adminClient?: any;
}): Promise<PaginatedUsersResult> {
  const admin = options.adminClient || getSupabaseAdmin();
  const page = Math.max(1, options.page);
  const pageSize = Math.min(100, Math.max(1, options.pageSize));
  const query = (options.searchQuery || '').trim().toLowerCase();
  const now = new Date();

  // 1. Fetch exactly one page natively from Supabase Auth
  const { data, error } = await admin.auth.admin.listUsers({
    page,
    perPage: pageSize,
  });

  if (error) {
    throw new Error(error.message || `Failed to list users on page ${page}`);
  }

  const rawUsers: any[] = data?.users || [];
  const total = typeof data?.total === 'number' ? data.total : rawUsers.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasNextPage = page < totalPages;
  const hasPrevPage = page > 1;

  if (rawUsers.length === 0) {
    return {
      users: [],
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasNextPage: false,
        hasPrevPage,
      },
      searchNotice: query
        ? 'Email search filters users on the current page. Global search across all accounts requires server-side index configuration.'
        : null,
    };
  }

  const pageUserIds = rawUsers.map((u: any) => u.id);

  // 2. Bounded supplementary queries: strictly scoped to pageUserIds
  // A. Subscriptions for page user IDs only
  const activeSubs = new Set<string>();
  try {
    const { data: subsData } = await admin
      .from('subscriptions')
      .select('user_id, status, current_period_end')
      .in('user_id', pageUserIds);

    if (Array.isArray(subsData)) {
      for (const s of subsData) {
        if (s.status === 'active' && (!s.current_period_end || new Date(s.current_period_end) > now)) {
          activeSubs.add(s.user_id);
        }
      }
    }
  } catch (_) {}

  // B. Blocked status for page user IDs only
  const blockedUsersMap = new Map<string, { blockedAt?: string; reason?: string }>();
  try {
    const { data: blockedRows } = await admin
      .from('blocked_users')
      .select('user_id, blocked_at, reason')
      .in('user_id', pageUserIds);

    if (Array.isArray(blockedRows)) {
      for (const b of blockedRows) {
        blockedUsersMap.set(b.user_id, {
          blockedAt: b.blocked_at,
          reason: b.reason,
        });
      }
    }
  } catch (_) {}

  // C. Page views count via bounded count-only queries (0 row data downloaded, head: true)
  // Direct multi-user aggregate grouping (GROUP BY user_id) in a single request requires an elevated
  // PostgreSQL RPC function or view (locked in Phase A1c). Bounded count-only queries prevent row downloading.
  // When a count query fails or errors for an individual user, totalViews is explicitly set to null
  // (rendered as "Unavailable" / "—" in UI) rather than falsely reporting 0. True successful zeroes remain 0.
  const userViewsCount = new Map<string, number | null>();
  const BATCH_SIZE = 5;
  for (let i = 0; i < pageUserIds.length; i += BATCH_SIZE) {
    const batch = pageUserIds.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (uid: string) => {
        try {
          const { count, error } = await admin
            .from('page_views')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', uid);

          if (error || typeof count !== 'number') {
            userViewsCount.set(uid, null);
          } else {
            userViewsCount.set(uid, count);
          }
        } catch (_) {
          userViewsCount.set(uid, null);
        }
      })
    );
  }

  // Supplement with in-memory fallback views buffer count for page user IDs only if count query succeeded
  for (const row of inMemoryViews) {
    if (row.user_id && pageUserIds.includes(row.user_id)) {
      const current = userViewsCount.get(row.user_id);
      if (typeof current === 'number') {
        userViewsCount.set(row.user_id, current + 1);
      }
    }
  }

  // 3. Filter current bounded page by email search query if provided
  let filteredUsers = rawUsers;
  let searchNotice: string | null = null;
  if (query) {
    filteredUsers = rawUsers.filter((u: any) => (u.email || '').toLowerCase().includes(query));
    searchNotice =
      'Email search filters users on the current page. Global search across all accounts requires server-side index configuration.';
  }

  const userItems: UserManagementItem[] = filteredUsers.map((u: any) => {
    const isPro = activeSubs.has(u.id) || u.user_metadata?.is_pro === true;
    const blockedRecord = blockedUsersMap.get(u.id);
    const isBlocked =
      Boolean(u.banned_until && new Date(u.banned_until) > now) ||
      u.user_metadata?.is_blocked === true ||
      Boolean(blockedRecord);

    const totalViews = userViewsCount.has(u.id) ? userViewsCount.get(u.id)! : null;

    return {
      id: u.id,
      email: u.email || 'anonymous',
      createdAt: u.created_at,
      lastSignInAt: u.last_sign_in_at,
      isPro,
      isBlocked,
      totalViews,
      blockedAt: blockedRecord?.blockedAt || u.user_metadata?.blocked_at,
      blockedReason: blockedRecord?.reason || u.user_metadata?.blocked_reason,
    };
  });

  return {
    users: userItems,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasNextPage,
      hasPrevPage,
    },
    searchNotice,
  };
}

/**
 * Returns timeline activity logs for a specific user ID.
 */
export async function getUserActivityLogs(
  userId: string,
  adminClient?: any
): Promise<PageViewRecord[]> {
  if (!userId) return [];
  const admin = adminClient || getSupabaseAdmin();

  let userLogs: PageViewRecord[] = [];

  try {
    const { data, error } = await admin
      .from("page_views")
      .select("id, path, user_id, referrer, ip_hash, user_agent, created_at")
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

    if (shouldBlock && user.email && ADMIN_EMAIL && user.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
      return { success: false, isBlocked: false, error: "Admin account cannot be blocked" };
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
