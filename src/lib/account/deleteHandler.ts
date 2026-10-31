import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkRequiredEnv } from "@/lib/api/envCheck";

export interface AccountDeleteRouteDeps {
  getSupabaseAdmin?: () => any;
}

export const ACCOUNT_DELETE_USER_ID_TABLES = [
  "candidate_profiles",
  "user_preferences",
  "resumes",
  "tailored_resumes",
  "saved_jobs",
  "applications",
  "job_applications",
  "subscriptions",
  "search_alerts",
  "daily_digests",
  "ai_usage_quotas",
  "ai_usage_ledger",
  "page_views",
  "user_roles",
  "user_consents",
] as const;

export const ACCOUNT_DELETE_EMAIL_TABLES = [
  "early_access_emails",
] as const;

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  const missing = checkRequiredEnv(
    {
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    },
    "API /account/delete"
  );
  if (missing) {
    throw new Error(JSON.stringify(missing));
  }

  return createClient(supabaseUrl, serviceKey!, {
    auth: { persistSession: false },
  });
}

/**
 * Server-owned, authenticated account deletion workflow:
 * 1. Authenticates caller via Bearer access token.
 * 2. Refuses deletion if user is banned in `blocked_users` (fail-closed on DB error).
 * 3. Reconciles any active subscription, then removes all user rows:
 *    - profile (`candidate_profiles`, `user_preferences`)
 *    - resumes (`resumes`, `tailored_resumes`)
 *    - saved jobs (`saved_jobs`)
 *    - applications (`applications`, `job_applications`)
 *    - subscriptions (`subscriptions`)
 *    - early_access link (`early_access_emails` by lowercase email)
 *    - auxiliary user tables (`search_alerts`, `daily_digests`, `ai_usage_quotas`, `ai_usage_ledger`, `page_views`, `user_roles`, `user_consents`)
 * 4. Removes stored resume files from the private `resumes` bucket (`<userId>/*`) and any other storage buckets.
 * 5. Deletes the auth identity from Supabase Auth (`auth.users`).
 */
export async function handleAccountDeleteRequest(
  req: Request,
  deps: AccountDeleteRouteDeps = {}
) {
  try {
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        { success: false, error: "Unauthorized. Missing or invalid authorization header." },
        { status: 401 }
      );
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const adminGetter = deps.getSupabaseAdmin || getSupabaseAdmin;
    const supabaseAdmin = adminGetter();

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
    const normalizedEmail = String(user.email || "").trim().toLowerCase();

    // 2. Moderation check: Refuse deletion if user is banned (fail-closed)
    try {
      const { data: banRecord, error: banLookupError } = await supabaseAdmin
        .from("blocked_users")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle();

      if (banLookupError) {
        return NextResponse.json(
          {
            success: false,
            error: "Service temporarily unavailable. Please try again later.",
          },
          { status: 503 }
        );
      }

      if (banRecord) {
        return NextResponse.json(
          {
            success: false,
            error: "Account cannot be deleted. Contact support@careermonke.com",
          },
          { status: 403 }
        );
      }
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: "Service temporarily unavailable. Please try again later.",
        },
        { status: 503 }
      );
    }

    // 3. Reconcile active subscription before removing user rows
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

    // 4. Delete user-owned rows across all user_id tables + early_access link
    const errors: string[] = [];

    const isIgnorableDeleteError = (err: any) => {
      if (!err) return true;
      if (err.code === "23503") return false;
      const msg = (err.message || "").toLowerCase();
      return (
        err.code === "PGRST116" ||
        err.code === "PGRST205" ||
        err.code === "42P01" ||
        msg.includes("schema cache") ||
        msg.includes("does not exist")
      );
    };

    for (const table of ACCOUNT_DELETE_USER_ID_TABLES) {
      const { error } = await supabaseAdmin
        .from(table)
        .delete()
        .eq("user_id", userId);
      if (!isIgnorableDeleteError(error)) {
        errors.push(`${table}: ${error?.message || JSON.stringify(error)}`);
      }
    }

    if (normalizedEmail) {
      for (const emailTable of ACCOUNT_DELETE_EMAIL_TABLES) {
        const { error } = await supabaseAdmin
          .from(emailTable)
          .delete()
          .eq("email", normalizedEmail);
        if (!isIgnorableDeleteError(error)) {
          errors.push(`${emailTable}: ${error?.message || JSON.stringify(error)}`);
        }
      }
    }

    // 5. Remove stored resume files from private `resumes` bucket and any additional buckets
    const deletedStoragePaths: string[] = [];
    try {
      const bucketNames = new Set<string>(["resumes"]);
      if (typeof supabaseAdmin.storage?.listBuckets === "function") {
        const { data: buckets } = await supabaseAdmin.storage.listBuckets();
        if (Array.isArray(buckets)) {
          for (const b of buckets) {
            if (b?.name) bucketNames.add(b.name);
          }
        }
      }

      for (const bucketName of Array.from(bucketNames)) {
        const bucketApi = supabaseAdmin.storage?.from?.(bucketName);
        if (!bucketApi || typeof bucketApi.list !== "function") continue;
        const { data: files, error: listErr } = await bucketApi.list(userId);
        if (listErr) continue;
        if (Array.isArray(files) && files.length > 0) {
          const filePaths = files
            .filter((f: any) => f && typeof f.name === "string" && f.name.length > 0)
            .map((f: any) => `${userId}/${f.name}`);
          if (filePaths.length > 0) {
            const { error: removeErr } = await bucketApi.remove(filePaths);
            if (removeErr) {
              errors.push(`storage.${bucketName}: ${removeErr.message || String(removeErr)}`);
            } else {
              deletedStoragePaths.push(...filePaths.map((p: string) => `${bucketName}/${p}`));
            }
          }
        }
      }
    } catch (storageErr: any) {
      errors.push(`storage: ${storageErr?.message || String(storageErr)}`);
    }

    // If any row or storage deletions failed, abort before deleting auth user
    if (errors.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `Failed to delete all user data: ${errors.join(", ")}`,
        },
        { status: 500 }
      );
    }

    // 6. Delete the Auth User Identity from Supabase Auth (last step)
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
      deletedStoragePaths,
      message: "User account and all owned data permanently deleted.",
    });
  } catch (err: any) {
    try {
      const parsed = JSON.parse(err?.message);
      if (parsed.missingVariable) {
        return NextResponse.json(parsed, { status: 500 });
      }
    } catch {}
    console.error("Account delete error:", err);
    return NextResponse.json(
      { success: false, error: err?.message || "Internal server error during account deletion." },
      { status: 500 }
    );
  }
}
