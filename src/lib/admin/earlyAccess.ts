import { getSupabaseAdmin } from "./auth";
import { getRuntimeEnv } from "@/lib/ai/serviceHandler";
import {
  readAppsScriptConfig,
  dispatchAppsScriptMail,
} from "@/lib/early-access/gmail";
import {
  setApprovalCache,
  invalidateApprovalCache,
} from "@/lib/auth/approval";

export interface EarlyAccessRequestItem {
  email: string;
  created_at: string;
  status: "pending" | "approved" | "rejected";
  approved_at?: string | null;
  approved_by?: string | null;
}

export interface ListEarlyAccessOptions {
  page?: number;
  limit?: number;
  status?: string;
  customClient?: any;
}

export interface ListEarlyAccessResult {
  ok: boolean;
  requests: EarlyAccessRequestItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  error?: string;
}

export interface ApproveEarlyAccessOptions {
  adminEmail: string;
  targetEmail: string;
  cfEnv?: Record<string, any>;
  customClient?: any;
}

export interface ApproveEarlyAccessResult {
  ok: boolean;
  email: string;
  status: "approved";
  approved_at: string | null;
  approved_by: string | null;
  already_approved?: boolean;
  notify_skipped: boolean;
  error?: string;
}

export interface RejectEarlyAccessOptions {
  adminEmail: string;
  targetEmail: string;
  reason?: string;
  customClient?: any;
}

export interface RejectEarlyAccessResult {
  ok: boolean;
  email: string;
  status: "rejected";
  approved_at: string | null;
  approved_by: string | null;
  already_rejected?: boolean;
  reason?: string;
  error?: string;
}

export function resolveSupabaseAdmin(customClient?: any): any {
  if (customClient) return customClient;
  if (
    process.env.NODE_ENV === "test" &&
    (globalThis as any).__mockSupabaseAdmin !== undefined
  ) {
    return (globalThis as any).__mockSupabaseAdmin;
  }
  if (
    process.env.NODE_ENV === "test" &&
    (globalThis as any).__mockSupabaseClient !== undefined
  ) {
    return (globalThis as any).__mockSupabaseClient;
  }
  return getSupabaseAdmin();
}

/**
 * Normalizes email address for database consistency.
 */
export function normalizeEmail(raw: string): string {
  return String(raw || "").trim().toLowerCase();
}

/**
 * Lists early-access waitlist requests with pagination and status filtering.
 * Defaults to status: 'pending'.
 */
export async function listPendingEarlyAccessRequests(
  options?: ListEarlyAccessOptions
): Promise<ListEarlyAccessResult> {
  try {
    const client = resolveSupabaseAdmin(options?.customClient);
    if (!client || typeof client.from !== "function") {
      return {
        ok: false,
        requests: [],
        total: 0,
        page: 1,
        limit: 25,
        totalPages: 0,
        error: "Database client unavailable",
      };
    }

    const page = Math.max(1, Number(options?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(options?.limit) || 25));
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    const statusFilter = options?.status || "pending";

    let query = client
      .from("early_access_emails")
      .select("email, created_at, status, approved_at, approved_by", {
        count: "exact",
      });

    if (statusFilter !== "all") {
      query = query.eq("status", statusFilter);
    }

    const { data, count, error } = await query
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) {
      return {
        ok: false,
        requests: [],
        total: 0,
        page,
        limit,
        totalPages: 0,
        error: error.message || "Failed to retrieve early access requests",
      };
    }

    const total = typeof count === "number" ? count : data?.length || 0;
    const totalPages = Math.ceil(total / limit);

    const requests: EarlyAccessRequestItem[] = (data || []).map((row: any) => ({
      email: row.email,
      created_at: row.created_at,
      status: (row.status as any) || "pending",
      approved_at: row.approved_at || null,
      approved_by: row.approved_by || null,
    }));

    return {
      ok: true,
      requests,
      total,
      page,
      limit,
      totalPages,
    };
  } catch (err: any) {
    return {
      ok: false,
      requests: [],
      total: 0,
      page: 1,
      limit: 25,
      totalPages: 0,
      error: err?.message || "Internal error listing early access requests",
    };
  }
}

/**
 * Idempotently approves an early-access request:
 * 1. Admin identity is derived server-side (never trusts client role).
 * 2. Writes approved_at and approved_by to early_access_approved and early_access_emails.
 * 3. Idempotent: If already approved, returns already_approved: true with existing timestamps.
 * 4. Dispatches notification email via Apps Script mail route.
 *    If EARLY_ACCESS_NOTIFY_EMAIL or APPS_SCRIPT_MAIL_URL is missing, succeeds and returns notify_skipped: true (no crash).
 */
export async function approveEarlyAccessRequest(
  options: ApproveEarlyAccessOptions
): Promise<ApproveEarlyAccessResult> {
  const normalizedEmail = normalizeEmail(options.targetEmail);
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    return {
      ok: false,
      email: normalizedEmail,
      status: "approved",
      approved_at: null,
      approved_by: null,
      notify_skipped: true,
      error: "A valid email address is required for approval.",
    };
  }

  const adminEmail = String(options.adminEmail || "").trim();
  if (!adminEmail) {
    return {
      ok: false,
      email: normalizedEmail,
      status: "approved",
      approved_at: null,
      approved_by: null,
      notify_skipped: true,
      error: "Authenticated admin identifier is required.",
    };
  }

  const client = resolveSupabaseAdmin(options.customClient);
  if (!client || typeof client.from !== "function") {
    return {
      ok: false,
      email: normalizedEmail,
      status: "approved",
      approved_at: null,
      approved_by: null,
      notify_skipped: true,
      error: "Database client unavailable",
    };
  }

  try {
    // 1. Idempotency precheck: verify if already approved in early_access_approved
    const { data: existingApproved } = await client
      .from("early_access_approved")
      .select("approved, approved_at, approved_by")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (existingApproved?.approved === true) {
      return {
        ok: true,
        email: normalizedEmail,
        status: "approved",
        approved_at: existingApproved.approved_at || null,
        approved_by: existingApproved.approved_by || adminEmail,
        already_approved: true,
        notify_skipped: true,
      };
    }

    const nowIso = new Date().toISOString();

    // 2. Upsert into early_access_approved
    const { error: approvedError } = await client
      .from("early_access_approved")
      .upsert(
        {
          email: normalizedEmail,
          approved: true,
          approved_at: nowIso,
          approved_by: adminEmail,
          updated_at: nowIso,
        },
        { onConflict: "email" }
      );

    if (approvedError) {
      return {
        ok: false,
        email: normalizedEmail,
        status: "approved",
        approved_at: null,
        approved_by: null,
        notify_skipped: true,
        error: approvedError.message || "Failed to update early_access_approved",
      };
    }

    // 3. Update early_access_emails table (record approval status and admin details)
    try {
      await client
        .from("early_access_emails")
        .update({
          status: "approved",
          approved_at: nowIso,
          approved_by: adminEmail,
        })
        .eq("email", normalizedEmail);
    } catch (_) {
      // Non-fatal if early_access_emails row does not exist yet
    }

    // 4. Update in-memory approval cache so approval is immediately active
    setApprovalCache(normalizedEmail, true);

    // 5. Notification dispatch via existing Apps Script / notify path
    const notifyEmail = (
      getRuntimeEnv("EARLY_ACCESS_NOTIFY_EMAIL", options.cfEnv) ||
      process.env.EARLY_ACCESS_NOTIFY_EMAIL ||
      ""
    ).trim();
    const appsScriptConfig = readAppsScriptConfig(options.cfEnv);

    let notifySkipped = false;
    if (!notifyEmail || !appsScriptConfig.url) {
      notifySkipped = true;
    } else {
      try {
        await dispatchAppsScriptMail({
          url: appsScriptConfig.url,
          secret: appsScriptConfig.secret,
          payload: {
            email: notifyEmail,
            to: notifyEmail,
            recipient: notifyEmail,
            kind: "approval",
            subject: `Early access approved: ${normalizedEmail}`,
            approvedEmail: normalizedEmail,
            approvedBy: adminEmail,
            approvedAt: nowIso,
            textBody: `Early access request for ${normalizedEmail} was approved by ${adminEmail} at ${nowIso}.`,
            htmlBody: `<p>Early access request for <strong>${normalizedEmail}</strong> was approved by <strong>${adminEmail}</strong> at ${nowIso}.</p>`,
          },
        });
      } catch (_err) {
        // Must never crash; approve still succeeds
      }
    }

    return {
      ok: true,
      email: normalizedEmail,
      status: "approved",
      approved_at: nowIso,
      approved_by: adminEmail,
      notify_skipped: notifySkipped,
    };
  } catch (err: any) {
    return {
      ok: false,
      email: normalizedEmail,
      status: "approved",
      approved_at: null,
      approved_by: null,
      notify_skipped: true,
      error: err?.message || "Internal error approving request",
    };
  }
}

/**
 * Idempotently rejects an early-access request:
 * 1. Admin identity is derived server-side.
 * 2. Updates early_access_approved to approved = false.
 * 3. Updates early_access_emails status to 'rejected'.
 * 4. Idempotent: If already rejected, returns already_rejected: true without error.
 */
export async function rejectEarlyAccessRequest(
  options: RejectEarlyAccessOptions
): Promise<RejectEarlyAccessResult> {
  const normalizedEmail = normalizeEmail(options.targetEmail);
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    return {
      ok: false,
      email: normalizedEmail,
      status: "rejected",
      approved_at: null,
      approved_by: null,
      error: "A valid email address is required for rejection.",
    };
  }

  const adminEmail = String(options.adminEmail || "").trim();
  if (!adminEmail) {
    return {
      ok: false,
      email: normalizedEmail,
      status: "rejected",
      approved_at: null,
      approved_by: null,
      error: "Authenticated admin identifier is required.",
    };
  }

  const client = resolveSupabaseAdmin(options.customClient);
  if (!client || typeof client.from !== "function") {
    return {
      ok: false,
      email: normalizedEmail,
      status: "rejected",
      approved_at: null,
      approved_by: null,
      error: "Database client unavailable",
    };
  }

  try {
    // 1. Idempotency precheck: verify if already rejected
    const { data: existingEmailRow } = await client
      .from("early_access_emails")
      .select("status, approved_at, approved_by")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (existingEmailRow?.status === "rejected") {
      return {
        ok: true,
        email: normalizedEmail,
        status: "rejected",
        approved_at: existingEmailRow.approved_at || null,
        approved_by: existingEmailRow.approved_by || adminEmail,
        already_rejected: true,
      };
    }

    const nowIso = new Date().toISOString();

    // 2. Set approved = false in early_access_approved
    const { error: approvedError } = await client
      .from("early_access_approved")
      .upsert(
        {
          email: normalizedEmail,
          approved: false,
          approved_at: nowIso,
          approved_by: adminEmail,
          updated_at: nowIso,
        },
        { onConflict: "email" }
      );

    if (approvedError) {
      return {
        ok: false,
        email: normalizedEmail,
        status: "rejected",
        approved_at: null,
        approved_by: null,
        error: approvedError.message || "Failed to update early_access_approved",
      };
    }

    // 3. Set status = 'rejected' in early_access_emails
    try {
      await client
        .from("early_access_emails")
        .update({
          status: "rejected",
          approved_at: nowIso,
          approved_by: adminEmail,
        })
        .eq("email", normalizedEmail);
    } catch (_) {}

    // 4. Invalidate approval cache
    invalidateApprovalCache(normalizedEmail);

    return {
      ok: true,
      email: normalizedEmail,
      status: "rejected",
      approved_at: nowIso,
      approved_by: adminEmail,
      reason: options.reason,
    };
  } catch (err: any) {
    return {
      ok: false,
      email: normalizedEmail,
      status: "rejected",
      approved_at: null,
      approved_by: null,
      error: err?.message || "Internal error rejecting request",
    };
  }
}
