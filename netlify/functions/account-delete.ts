import { createClient } from "@supabase/supabase-js";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import { safeLog } from "./_logger";

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

export async function handler(event: any) {
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
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ success: false, error: "Missing or invalid authorization token" }),
      };
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const supabaseAdmin = getSupabaseAdmin();

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

    // 1. Reconcile active billing relationship without destroying audit records
    let billingReconciled = false;
    try {
      const { data: sub } = await supabaseAdmin
        .from("subscriptions")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (sub && sub.status === "active") {
        await supabaseAdmin
          .from("subscriptions")
          .update({
            status: "canceled",
            cancel_at_period_end: true,
            canceled_at: new Date().toISOString(),
            metadata: {
              ...(sub.metadata || {}),
              account_deleted_at: new Date().toISOString(),
            },
          })
          .eq("id", sub.id);
        billingReconciled = true;
      }
    } catch (billingErr) {
      safeLog.warn("[Netlify /account-delete] Billing reconciliation warning", billingErr);
    }

    // 1.5. Security Tradeoff: Anonymise ban row (disconnect user_id so CASCADE delete doesn't wipe ban, preserving email ban to prevent ban evasion)
    try {
      await supabaseAdmin
        .from("blocked_users")
        .update({ user_id: null })
        .eq("user_id", userId);
    } catch (banErr) {
      safeLog.warn("[Netlify /account-delete] Ban record anonymisation warning", banErr);
    }

    // 2. Delete user-owned data across all tables with individual error checking
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
      const msg = (err.message || "").toLowerCase();
      return (
        err.code === "PGRST116" ||
        err.code === "PGRST205" ||
        err.code === "42P01" ||
        msg.includes("schema cache") ||
        msg.includes("does not exist") ||
        msg.includes("relation")
      );
    };

    for (const table of tablesToDelete) {
      const { error } = await supabaseAdmin
        .from(table)
        .delete()
        .eq("user_id", userId);
      if (!isIgnorableDeleteError(error)) {
        errors.push(`${table}: ${error?.message}`);
      }
    }

    // Clean up storage files
    try {
      const { data: buckets } = await supabaseAdmin.storage.listBuckets();
      if (buckets && buckets.length > 0) {
        for (const bucket of buckets) {
          const { data: files } = await supabaseAdmin.storage
            .from(bucket.name)
            .list(userId);
          if (files && files.length > 0) {
            const filePaths = files.map((f) => `${userId}/${f.name}`);
            await supabaseAdmin.storage.from(bucket.name).remove(filePaths);
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
}
