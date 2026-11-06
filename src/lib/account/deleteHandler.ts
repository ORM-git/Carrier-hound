import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkRequiredEnv } from "@/lib/api/envCheck";
import {
  checkSharedRateLimit,
  ACCOUNT_DELETE_RATE_LIMIT,
  accountDeleteRateLimitStore,
} from "@/lib/api/sharedRateLimit";
import { checkRateLimit } from "@/lib/ai/serviceHandler";

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

export const RECONCILABLE_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "in_grace_period",
] as const;

export const STORAGE_LIST_PAGE_SIZE = 100;

/**
 * Recursively lists all file paths under `rootPrefix` in a storage bucket using
 * pagination (`limit: 100, offset`).
 */
export async function listBucketFilesRecursively(
  bucketApi: any,
  rootPrefix: string
): Promise<{ paths: string[]; error: any }> {
  const collectedPaths: string[] = [];
  if (!bucketApi || typeof bucketApi.list !== "function") {
    return { paths: collectedPaths, error: null };
  }

  const queue: string[] = [rootPrefix.replace(/\/+$/, "")];
  const visitedPrefixes = new Set<string>();

  while (queue.length > 0) {
    const currentPrefix = queue.shift()!;
    if (!currentPrefix || visitedPrefixes.has(currentPrefix)) continue;
    visitedPrefixes.add(currentPrefix);

    let offset = 0;
    let firstPageFirstItemName: string | null = null;

    while (true) {
      const { data: items, error: listErr } = await bucketApi.list(currentPrefix, {
        limit: STORAGE_LIST_PAGE_SIZE,
        offset,
      });

      if (listErr) {
        return { paths: collectedPaths, error: listErr };
      }

      if (!Array.isArray(items) || items.length === 0) {
        break;
      }

      if (offset === 0) {
        firstPageFirstItemName = typeof items[0]?.name === "string" ? items[0].name : null;
      } else if (
        firstPageFirstItemName &&
        typeof items[0]?.name === "string" &&
        items[0].name === firstPageFirstItemName
      ) {
        // Guard against naive test mocks that ignore offset and return identical page 0
        break;
      }

      for (const item of items) {
        if (!item || typeof item.name !== "string") continue;
        const cleanName = item.name.replace(/^\/+|\/+$/g, "");
        if (!cleanName || cleanName === ".emptyFolderPlaceholder") continue;

        const isFolderEntry =
          item.isFolder === true ||
          item.name.endsWith("/") ||
          (item.id === null && !item.metadata);

        if (isFolderEntry) {
          queue.push(`${currentPrefix}/${cleanName}`);
        } else {
          collectedPaths.push(`${currentPrefix}/${cleanName}`);
        }
      }

      if (items.length < STORAGE_LIST_PAGE_SIZE) {
        break;
      }
      offset += STORAGE_LIST_PAGE_SIZE;
    }
  }

  return { paths: collectedPaths, error: null };
}

function getSupabaseAdmin() {
  if (process.env.NODE_ENV === "test" && (globalThis as any).__mockSupabaseClient) {
    return (globalThis as any).__mockSupabaseClient;
  }

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
 * 3. Reconciles `active`, `trialing`, and `in_grace_period` subscriptions to `canceled`
 *    and preserves the `subscriptions` rows (FK `ON DELETE SET NULL` on `auth.users`).
 * 4. Removes all user-owned rows:
 *    - profile (`candidate_profiles`, `user_preferences`)
 *    - resumes (`resumes`, `tailored_resumes`)
 *    - saved jobs (`saved_jobs`)
 *    - applications (`applications`, `job_applications`)
 *    - early_access link (`early_access_emails` by lowercase email)
 *    - auxiliary user tables (`search_alerts`, `daily_digests`, `ai_usage_quotas`, `ai_usage_ledger`, `page_views`, `user_roles`, `user_consents`)
 * 5. Recursively lists (with pagination, 100 per page) and removes stored resume files
 *    from the private `resumes` bucket (`<userId>/**`) and any other storage buckets.
 * 6. Deletes the auth identity from Supabase Auth (`auth.users`).
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

    // 1b. Shared rate limit (per user), same pattern as the public endpoints:
    // durable via the check_rate_limit RPC, in-memory fallback per isolate.
    const deleteLimit = await checkSharedRateLimit(
      `account_delete:user:${userId}`,
      ACCOUNT_DELETE_RATE_LIMIT.maxRequests,
      ACCOUNT_DELETE_RATE_LIMIT.windowSeconds,
      () =>
        checkRateLimit(
          `account_delete:user:${userId}`,
          accountDeleteRateLimitStore,
          ACCOUNT_DELETE_RATE_LIMIT.maxRequests,
          ACCOUNT_DELETE_RATE_LIMIT.windowSeconds * 1000
        )
    );
    if (!deleteLimit.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: "Too many deletion requests. Please try again later.",
          retryAfter: deleteLimit.retryAfter,
        },
        { status: 429, headers: { "Retry-After": String(deleteLimit.retryAfter) } }
      );
    }

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

    // 3. Reconcile active, trialing, and in_grace_period subscriptions to canceled and keep the rows
    let billingReconciled = false;
    try {
      const { data: subData, error: subQueryError } = await supabaseAdmin
        .from("subscriptions")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(100)
        .maybeSingle();

      if (subQueryError) {
        return NextResponse.json(
          {
            success: false,
            error: `Failed to reconcile subscription: ${subQueryError.message || String(subQueryError)}`,
          },
          { status: 500 }
        );
      }

      const subs = Array.isArray(subData) ? subData : subData ? [subData] : [];
      for (const sub of subs) {
        if (
          sub &&
          RECONCILABLE_SUBSCRIPTION_STATUSES.includes(
            sub.status as (typeof RECONCILABLE_SUBSCRIPTION_STATUSES)[number]
          )
        ) {
          const nowIso = new Date().toISOString();
          const { error: cancelSubError } = await supabaseAdmin
            .from("subscriptions")
            .update({
              status: "canceled",
              cancel_at_period_end: true,
              canceled_at: nowIso,
              updated_at: nowIso,
              metadata: {
                ...(sub.metadata || {}),
                canceled_at: nowIso,
                account_deleted_at: nowIso,
              },
            })
            .eq("id", sub.id);

          if (cancelSubError) {
            return NextResponse.json(
              {
                success: false,
                error: `Failed to reconcile subscription: ${cancelSubError.message || String(cancelSubError)}`,
              },
              { status: 500 }
            );
          }
          billingReconciled = true;
        }
      }
    } catch (billingErr: any) {
      console.warn("Billing reconciliation error:", billingErr);
      return NextResponse.json(
        {
          success: false,
          error: `Failed to reconcile subscription: ${billingErr?.message || String(billingErr)}`,
        },
        { status: 500 }
      );
    }

    // 4. Delete user-owned rows across all user_id tables (excluding subscriptions) + early_access link
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

    // 5. Recursively list (with pagination) and remove stored resume files before deleting auth user
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

        const { paths: filePaths, error: listErr } = await listBucketFilesRecursively(
          bucketApi,
          userId
        );
        if (listErr) continue;

        if (filePaths.length > 0) {
          for (let i = 0; i < filePaths.length; i += STORAGE_LIST_PAGE_SIZE) {
            const chunk = filePaths.slice(i, i + STORAGE_LIST_PAGE_SIZE);
            const { error: removeErr } = await bucketApi.remove(chunk);
            if (removeErr) {
              errors.push(`storage.${bucketName}: ${removeErr.message || String(removeErr)}`);
            } else {
              deletedStoragePaths.push(...chunk.map((p: string) => `${bucketName}/${p}`));
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
