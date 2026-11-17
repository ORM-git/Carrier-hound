import { NextResponse } from "next/server";
import { getSupabaseAdminClient, getClientIpFromRequest } from "@/lib/ai/serviceHandler";
import { checkSharedRateLimitStrict } from "@/lib/api/sharedRateLimit";
import {
  BodyTooLargeError,
  MAX_MULTIPART_OVERHEAD_BYTES,
  MAX_RESUME_SIZE_BYTES,
  RESUME_BUCKET,
  RESUME_MIME,
  buildResumeStoragePath,
  readBodyWithLimit,
  sanitizeResumeFileName,
  validateResumeFile,
} from "@/lib/onboarding/step2Resume";
import { isOnboardingStep2EnabledServer } from "@/config/onboarding";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { route: "/api/onboarding/resume" } });

export const runtime = "edge";

const NO_STORE = "private, no-cache, no-store, must-revalidate";
const ORPHAN_SWEEP_LIMIT = 20;
const SAVE_FAILED = "Couldn't save your resume. Please try again.";

function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": NO_STORE } });
}

/** Best-effort removal of onboarding objects that have no pointer row (crash leftovers, replaced files). */
async function sweepOrphans(supabaseAdmin: any): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc("list_onboarding_resume_orphans", {
    p_older_than: "1 hour",
    p_limit: ORPHAN_SWEEP_LIMIT,
  });
  if (error) {
    log.warn("Orphan listing failed", { error: error.message });
    return;
  }
  const names = (Array.isArray(data) ? data : []).map((r: any) => r?.object_name).filter(Boolean);
  if (names.length === 0) return;
  const { error: removeError } = await supabaseAdmin.storage.from(RESUME_BUCKET).remove(names);
  if (removeError) {
    log.warn("Orphan removal failed", { count: names.length, error: removeError.message });
  }
}

/** Removes an uploaded blob that never got a committed pointer. Never throws. */
async function removeUncommitted(supabaseAdmin: any, path: string, userId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.storage.from(RESUME_BUCKET).remove([path]);
    if (error) {
      log.error("Cleanup of uncommitted resume failed (orphan sweep will retry)", { userId, error: error.message });
    }
  } catch (err: any) {
    log.error("Cleanup of uncommitted resume threw (orphan sweep will retry)", { userId, error: err?.message });
  }
}

/**
 * Stores an onboarding resume (PDF/DOCX, <= 5 MB) privately under <uid>/onboarding/.
 * Store only: no parsing or text extraction happens here.
 */
export async function POST(req: Request) {
  let cfEnv: Record<string, any> | undefined;
  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try {
    const ctx = getRequestContext();
    if (ctx?.env) cfEnv = ctx.env as Record<string, any>;
    if (ctx?.ctx?.waitUntil) waitUntil = ctx.ctx.waitUntil.bind(ctx.ctx);
  } catch {}

  if (!isOnboardingStep2EnabledServer(cfEnv)) {
    return json({ error: "Feature is coming soon", code: "FEATURE_COMING_SOON" }, 503);
  }

  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ error: "Unauthorized: Missing authentication token" }, 401);
  }

  // Service role only: no anon-key fallback. Missing key => 503.
  let supabaseAdmin: any;
  try {
    supabaseAdmin = getSupabaseAdminClient(cfEnv);
  } catch (err: any) {
    log.error("Service role client unavailable", { error: err?.message });
    return json({ error: "Service unavailable" }, 503);
  }

  // Tracks the blob written in this request and whether its pointer row committed, so any
  // failure after the upload (returned or thrown) removes the blob in `finally`.
  let uploadedPath: string | null = null;
  let pointerCommitted = false;
  let userId = "unknown";

  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7).trim());
    const user = authData?.user;
    if (authError || !user) {
      return json({ error: "Unauthorized: Invalid session" }, 401);
    }
    userId = user.id;

    // Rate limit before reading the body: per user and per IP, fail closed if the store is down.
    const ip = getClientIpFromRequest(req);
    const [userLimit, ipLimit] = await Promise.all([
      checkSharedRateLimitStrict(`onboarding_resume:user:${user.id}`, 10, 3600, { env: cfEnv }),
      checkSharedRateLimitStrict(`onboarding_resume:ip:${ip}`, 30, 3600, { env: cfEnv }),
    ]);
    if (!userLimit.allowed || !ipLimit.allowed) {
      const res = json({ error: "Too many uploads. Please try again later." }, 429);
      res.headers.set("Retry-After", String(Math.max(userLimit.retryAfter, ipLimit.retryAfter, 1)));
      return res;
    }

    const contentType = req.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      return json({ error: "Upload must be multipart/form-data." }, 415);
    }

    // Size cap before buffering: the stream is cut off past 5 MB + multipart framing.
    let raw: Uint8Array;
    try {
      raw = await readBodyWithLimit(req, MAX_RESUME_SIZE_BYTES + MAX_MULTIPART_OVERHEAD_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return json({ error: "Resume must be 5 MB or smaller." }, 413);
      }
      return json({ error: "Couldn't read the upload. Please try again." }, 400);
    }

    let file: FormDataEntryValue | null;
    try {
      const form = await new Response(raw as unknown as BodyInit, { headers: { "content-type": contentType } }).formData();
      file = form.get("file");
    } catch {
      return json({ error: "Invalid upload. Please choose a PDF or DOCX file." }, 400);
    }
    if (!file || typeof file === "string") {
      return json({ error: "Please choose a PDF or DOCX file." }, 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileName = sanitizeResumeFileName(file.name || "resume");
    const check = validateResumeFile(bytes, file.type, fileName);
    if (!check.ok || !check.kind) {
      return json({ error: check.error || "Please upload a PDF or DOCX file." }, 400);
    }
    const kind = check.kind;

    // Read the current pointer first so we know which object to retire on success.
    const { data: previous, error: readError } = await supabaseAdmin
      .from("onboarding_resume_uploads")
      .select("storage_path")
      .eq("user_id", user.id)
      .maybeSingle();
    if (readError) {
      log.error("Failed to read onboarding_resume_uploads", { userId, error: readError.message });
      return json({ error: SAVE_FAILED }, 500);
    }

    const storagePath = buildResumeStoragePath(user.id, kind);
    // Mark before the call: a thrown/timeout upload may still have written the object.
    uploadedPath = storagePath;
    const { error: uploadError } = await supabaseAdmin.storage
      .from(RESUME_BUCKET)
      .upload(storagePath, new Blob([bytes], { type: RESUME_MIME[kind] }), {
        contentType: RESUME_MIME[kind],
        upsert: false,
      });
    if (uploadError) {
      log.error("Resume storage upload failed", { userId, error: uploadError.message });
      return json({ error: SAVE_FAILED }, 500);
    }

    const { error: upsertError } = await supabaseAdmin.from("onboarding_resume_uploads").upsert(
      {
        user_id: user.id,
        storage_path: storagePath,
        file_name: fileName,
        mime_type: RESUME_MIME[kind],
        size_bytes: bytes.byteLength,
        uploaded_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    if (upsertError) {
      log.error("Resume pointer upsert failed", { userId, error: upsertError.message });
      return json({ error: SAVE_FAILED }, 500);
    }
    pointerCommitted = true;

    // Post-commit housekeeping must never turn a saved upload into an error.
    if (previous?.storage_path && previous.storage_path !== storagePath) {
      try {
        const { error: removeOldError } = await supabaseAdmin.storage.from(RESUME_BUCKET).remove([previous.storage_path]);
        if (removeOldError) {
          log.warn("Removing replaced resume failed (orphan sweep will retry)", { userId, error: removeOldError.message });
        }
      } catch (err: any) {
        log.warn("Removing replaced resume threw (orphan sweep will retry)", { userId, error: err?.message });
      }
    }
    const sweep = sweepOrphans(supabaseAdmin).catch((err) => log.warn("Orphan sweep threw", { error: err?.message }));
    if (waitUntil) waitUntil(sweep);
    else await sweep;

    return json({ ok: true, fileName, sizeBytes: bytes.byteLength, kind });
  } catch (err: any) {
    log.error("Unhandled error in resume upload", { userId, error: err?.message || String(err) });
    return json({ error: SAVE_FAILED }, 500);
  } finally {
    if (uploadedPath && !pointerCommitted) {
      await removeUncommitted(supabaseAdmin, uploadedPath, userId);
    }
  }
}
