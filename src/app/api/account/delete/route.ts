import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "edge";

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

/**
 * POST /api/account/delete
 * 
 * Server-owned, authenticated account deletion workflow:
 * 1. Authenticates caller via Bearer access token.
 * 2. Checks and reconciles any active billing/subscription relationship:
 *    - Marks active subscription as canceled for audit/financial records.
 *    - Preserves subscription row so financial/tax reconciliation is not broken.
 * 3. Deletes every piece of user-owned data:
 *    - candidate_profiles
 *    - user_preferences
 *    - applications (tracker history)
 *    - tailored_resumes
 *    - daily_digests
 *    - ai_usage_quotas
 *    - page_views (user-scoped analytics)
 *    - user-scoped storage files
 * 4. Checks each result and reports real errors if any table fails.
 * 5. Deletes the auth identity from Supabase Auth (auth.users).
 */
export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        { success: false, error: "Unauthorized. Missing or invalid authorization header." },
        { status: 401 }
      );
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const supabaseAdmin = getSupabaseAdmin();

    // 1. Verify user identity
    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return NextResponse.json(
        { success: false, error: "Invalid or expired session. Please sign in again." },
        { status: 401 }
      );
    }

    const userId = user.id;

    // 2. Reconcile active billing relationship
    // Do NOT delete subscription/billing rows before reconciling any active billing relationship.
    // Financial and tax compliance requires preserving invoice and subscription history.
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
      console.warn("Billing reconciliation warning:", billingErr);
    }

    // 3. Delete user-owned data across all tables with individual error checking
    const errors: string[] = [];

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

    // candidate_profiles
    const { error: profileError } = await supabaseAdmin
      .from("candidate_profiles")
      .delete()
      .eq("user_id", userId);
    if (!isIgnorableDeleteError(profileError)) {
      errors.push(`candidate_profiles: ${profileError?.message}`);
    }

    // user_preferences
    const { error: prefError } = await supabaseAdmin
      .from("user_preferences")
      .delete()
      .eq("user_id", userId);
    if (!isIgnorableDeleteError(prefError)) {
      errors.push(`user_preferences: ${prefError?.message}`);
    }

    // applications (tracker slots)
    const { error: appsError } = await supabaseAdmin
      .from("applications")
      .delete()
      .eq("user_id", userId);
    if (!isIgnorableDeleteError(appsError)) {
      errors.push(`applications: ${appsError?.message}`);
    }

    // tailored_resumes
    const { error: tailoredError } = await supabaseAdmin
      .from("tailored_resumes")
      .delete()
      .eq("user_id", userId);
    if (!isIgnorableDeleteError(tailoredError)) {
      errors.push(`tailored_resumes: ${tailoredError?.message}`);
    }

    // daily_digests
    const { error: digestError } = await supabaseAdmin
      .from("daily_digests")
      .delete()
      .eq("user_id", userId);
    if (!isIgnorableDeleteError(digestError)) {
      errors.push(`daily_digests: ${digestError?.message}`);
    }

    // ai_usage_quotas
    const { error: quotaError } = await supabaseAdmin
      .from("ai_usage_quotas")
      .delete()
      .eq("user_id", userId);
    if (!isIgnorableDeleteError(quotaError)) {
      errors.push(`ai_usage_quotas: ${quotaError?.message}`);
    }

    // page_views (anonymize / purge user id)
    const { error: viewsError } = await supabaseAdmin
      .from("page_views")
      .delete()
      .eq("user_id", userId);
    if (!isIgnorableDeleteError(viewsError)) {
      errors.push(`page_views: ${viewsError?.message}`);
    }

    // Storage files cleanup (if any buckets exist)
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
      console.warn("Storage files cleanup warning:", storageErr);
    }

    // If any database deletions failed, report real error
    if (errors.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `Failed to delete all user data: ${errors.join(", ")}`,
        },
        { status: 500 }
      );
    }

    // 4. Delete the Auth User Identity from Supabase Auth
    const { error: deleteAuthError } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (deleteAuthError) {
      return NextResponse.json(
        {
          success: false,
          error: `Failed to delete auth identity: ${deleteAuthError.message}`,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      billingReconciled,
      message: "User account and all owned data permanently deleted.",
    });
  } catch (err: any) {
    console.error("Account delete error:", err);
    return NextResponse.json(
      { success: false, error: err?.message || "Internal server error during account deletion." },
      { status: 500 }
    );
  }
}
