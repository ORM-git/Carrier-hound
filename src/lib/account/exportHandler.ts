import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkRequiredEnv } from "@/lib/api/envCheck";
import {
  ACCOUNT_DELETE_USER_ID_TABLES,
  ACCOUNT_DELETE_EMAIL_TABLES,
  listBucketFilesRecursively,
} from "@/lib/account/deleteHandler";

export interface AccountExportRouteDeps {
  getSupabaseAdmin?: () => any;
}

/** Tables exported by auth user id (same ownership map as account deletion). */
export const ACCOUNT_EXPORT_USER_ID_TABLES = [
  ...ACCOUNT_DELETE_USER_ID_TABLES,
  "subscriptions",
] as const;

/** Tables matched by the account email (early-access link). */
export const ACCOUNT_EXPORT_EMAIL_TABLES = [...ACCOUNT_DELETE_EMAIL_TABLES] as const;

export const ACCOUNT_EXPORT_STORAGE_BUCKETS = ["resumes"] as const;

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
    "API /account/export"
  );
  if (missing) {
    throw new Error(JSON.stringify(missing));
  }

  return createClient(supabaseUrl, serviceKey!, {
    auth: { persistSession: false },
  });
}

function isIgnorableTableError(err: any) {
  if (!err) return true;
  const msg = (err.message || "").toLowerCase();
  return (
    err.code === "PGRST116" ||
    err.code === "PGRST205" ||
    err.code === "42P01" ||
    msg.includes("schema cache") ||
    msg.includes("does not exist")
  );
}

/**
 * Self-serve data export (DPDP portability): authenticated via Bearer access
 * token, returns every row the account owns as a downloadable JSON document.
 *
 * Scope mirrors account deletion: all user_id tables plus subscriptions, the
 * early-access email link, and a manifest (paths only, no file bytes) of the
 * user's stored resume files. Tables that do not exist in a given environment
 * are skipped rather than failing the export.
 */
export async function handleAccountExportRequest(
  req: Request,
  deps: AccountExportRouteDeps = {}
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

    const data: Record<string, unknown[]> = {};
    const errors: string[] = [];

    for (const table of ACCOUNT_EXPORT_USER_ID_TABLES) {
      const { data: rows, error } = await supabaseAdmin
        .from(table)
        .select("*")
        .eq("user_id", userId);
      if (!isIgnorableTableError(error)) {
        errors.push(`${table}: ${error?.message || JSON.stringify(error)}`);
        continue;
      }
      data[table] = Array.isArray(rows) ? rows : [];
    }

    if (normalizedEmail) {
      for (const table of ACCOUNT_EXPORT_EMAIL_TABLES) {
        const { data: rows, error } = await supabaseAdmin
          .from(table)
          .select("*")
          .eq("email", normalizedEmail);
        if (!isIgnorableTableError(error)) {
          errors.push(`${table}: ${error?.message || JSON.stringify(error)}`);
          continue;
        }
        data[table] = Array.isArray(rows) ? rows : [];
      }
    }

    // Storage manifest: list the user's files (paths only, never bytes) so the
    // export documents what is stored without streaming file content.
    const storageFiles: Record<string, string[]> = {};
    try {
      for (const bucket of ACCOUNT_EXPORT_STORAGE_BUCKETS) {
        const bucketApi = supabaseAdmin?.storage?.from?.(bucket);
        if (!bucketApi) continue;
        const { paths, error } = await listBucketFilesRecursively(bucketApi, userId);
        if (!error) storageFiles[bucket] = paths;
      }
    } catch {
      // Storage listing is best-effort; a storage failure must not block the export.
    }

    if (errors.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `Export failed for: ${errors.join("; ")}`,
        },
        { status: 500 }
      );
    }

    const generatedAt = new Date().toISOString();
    const exportPayload = {
      export_version: 1,
      generated_at: generatedAt,
      user: {
        id: userId,
        email: user.email || null,
      },
      tables: data,
      storage_files: storageFiles,
    };

    const dateStamp = generatedAt.slice(0, 10);
    return new NextResponse(JSON.stringify(exportPayload, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="careermonke-data-export-${dateStamp}.json"`,
        "cache-control": "no-store",
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || "Export failed. Please try again later." },
      { status: 500 }
    );
  }
}
