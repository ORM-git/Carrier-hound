import { createClient } from "@supabase/supabase-js";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import { safeLog } from "./_logger";

export interface AccountDeleteDeps {
  getSupabaseAdmin?: () => any;
}

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing server Supabase configuration");
  }

  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
}

const CORS_OPTIONS = {
  allowedMethods: "POST, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

export function createHandler(deps: AccountDeleteDeps = {}) {
  const adminGetter = deps.getSupabaseAdmin || getSupabaseAdmin;

  return async function handler(event: any) {
  const preflight = handleCorsPreflight(event, CORS_OPTIONS);
  if (preflight) return preflight;

  const headers = {
    "Content-Type": "application/json",
    ...buildCorsHeaders(event, CORS_OPTIONS),
  };

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ success: false, error: "Method not allowed" }),
    };
  }

  try {
    const authHeader = event.headers?.authorization || event.headers?.Authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ success: false, error: "Missing or invalid authorization token" }),
      };
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const supabaseAdmin = adminGetter();

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ success: false, error: "Invalid or expired session" }),
      };
    }

    const userId = user.id;

    // 0. Moderation check: Refuse deletion if user is banned (fail-closed)
    const { data: banRecord, error: banLookupError } = await supabaseAdmin
      .from("blocked_users")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (banLookupError) {
      safeLog.error("[Netlify /account-delete] Error checking blocked_users", banLookupError);
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({
          error: "Service temporarily unavailable. Please try again later.",
        }),
      };
    }

    if (banRecord) {
      safeLog.warn("[Netlify /account-delete]", `Refusing deletion for banned user ${userId}`);
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: "Account cannot be deleted. Contact support@careermonke.com",
        }),
      };
    }

    // 1. Reconcile active billing relationship without destroying audit records
    let billingReconciled = false;
    try {
      const { data: sub, error: subError } = await supabaseAdmin
        .from("subscriptions")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (subError) {
        safeLog.warn("[Netlify /account-delete] Subscription query error", subError);
      }

      if (sub && sub.status === "active") {
        const { error: cancelSubError } = await supabaseAdmin
          .from("subscriptions")
          .update({
            status: "canceled",
            cancel_at_period_end: true,
            updated_at: new Date().toISOString(),
            metadata: {
              ...(sub.metadata || {}),
              canceled_at: new Date().toISOString(),
              account_deleted_at: new Date().toISOString(),
            },
          })
          .eq("id", sub.id);

        if (cancelSubError) {
          safeLog.warn("[Netlify /account-delete] Billing reconciliation warning", cancelSubError);
        } else {
          billingReconciled = true;
        }
      }
    } catch (billingErr) {
      safeLog.warn("[Netlify /account-delete] Billing reconciliation warning", billingErr);
    }

    // 2. Delete user-owned data across all tables with individual error checking in bounded parallel groups of 4
    const errors: string[] = [];

    const tablesToDelete = [
      "candidate_profiles",
      "user_preferences",
      "search_alerts",
      "applications",
      "job_applications",
      "tailored_resumes",
      "daily_digests",
      "ai_usage_quotas",
      "ai_usage_ledger",
      "page_views",
      "user_roles",
      "user_consents",
    ];

    const isIgnorableDeleteError = (err: any) => {
      if (!err) return true;
      if (err.code === "23503") return false;
      return err.code === "42P01" || err.code === "PGRST205";
    };

    const DELETE_BATCH_SIZE = 4;
    for (let i = 0; i < tablesToDelete.length; i += DELETE_BATCH_SIZE) {
      const batch = tablesToDelete.slice(i, i + DELETE_BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async (table) => {
          const { error } = await supabaseAdmin
            .from(table)
            .delete()
            .eq("user_id", userId);
          return { table, error };
        })
      );

      for (let j = 0; j < batchResults.length; j++) {
        const res = batchResults[j];
        const table = batch[j];
        if (res.status === "rejected") {
          const reasonMsg = res.reason?.message || String(res.reason);
          errors.push(`${table}: ${reasonMsg}`);
        } else {
          const { error } = res.value;
          if (!isIgnorableDeleteError(error)) {
            errors.push(`${table}: ${error?.message || JSON.stringify(error)}`);
          }
        }
      }
    }

    // Clean up storage files
    try {
      const { data: buckets, error: bucketsError } = await supabaseAdmin.storage.listBuckets();
      if (bucketsError) {
        safeLog.warn("[Netlify /account-delete] List buckets warning", bucketsError);
      } else if (buckets && buckets.length > 0) {
        for (const bucket of buckets) {
          const { data: files, error: filesError } = await supabaseAdmin.storage
            .from(bucket.name)
            .list(userId);
          if (filesError) {
            safeLog.warn(`[Netlify /account-delete] List files in bucket ${bucket.name} warning`, filesError);
            continue;
          }
          if (files && files.length > 0) {
            const filePaths = files.map((f: any) => `${userId}/${f.name}`);
            const { error: removeError } = await supabaseAdmin.storage.from(bucket.name).remove(filePaths);
            if (removeError) {
              safeLog.warn(`[Netlify /account-delete] Remove files from bucket ${bucket.name} warning`, removeError);
            }
          }
        }
      }
    } catch (storageErr) {
      safeLog.warn("[Netlify /account-delete] Storage cleanup warning", storageErr);
    }

    if (errors.length > 0) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          success: false,
          error: `Failed to delete some user data: ${errors.join(", ")}`,
        }),
      };
    }

    // 3. Delete auth identity
    const { error: deleteAuthError } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (deleteAuthError) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          success: false,
          error: `Failed to delete auth identity: ${deleteAuthError.message}`,
        }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        billingReconciled,
        message: "User account and all owned data permanently deleted.",
      }),
    };
  } catch (err: any) {
    safeLog.error("[Netlify /account-delete]", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: err?.message || "Internal server error" }),
    };
  }
  };
}

export const handler = createHandler();
