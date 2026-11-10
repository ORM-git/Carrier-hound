import { NextResponse } from "next/server";
import { measureRouteBudget } from "@/lib/api/routeBudget";
import { getRequestContext } from "@cloudflare/next-on-pages";
import {
  checkSharedRateLimit,
  NOTIFY_ME_RATE_LIMIT,
  notifyMeRateLimitStore,
} from "@/lib/api/sharedRateLimit";
import {
  getClientIpFromRequest,
  checkRateLimit,
  getSupabaseAdminClient,
  getRuntimeEnv,
} from "@/lib/ai/serviceHandler";
import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";
import { createLogger } from "@/lib/observability/logger";
import {
  validateNotifyMeEmail,
  GENERIC_SUCCESS_MESSAGE,
  GENERIC_TRY_AGAIN_MESSAGE,
} from "@/lib/notify-me/validation";

const baseLog = createLogger({ context: { route: "/api/notify-me" } });

export const runtime = "edge";

async function postHandler(req: Request) {
  const log = baseLog.child({ requestId: req?.headers.get("x-request-id") ?? "unknown" });

  try {
    const isLegacy =
      process.env.NODE_ENV === "test" &&
      process.env.__CAREERMONKE_LEGACY_RATE_LIMIT === "true";

    const clientIp = getClientIpFromRequest(req);

    // 1. Shared rate limiting per IP (5 requests / 60 seconds)
    if (!isLegacy) {
      const ipLimit = await checkSharedRateLimit(
        `notify_me:ip:${clientIp}`,
        NOTIFY_ME_RATE_LIMIT.maxRequests,
        NOTIFY_ME_RATE_LIMIT.windowSeconds,
        () =>
          checkRateLimit(
            clientIp,
            notifyMeRateLimitStore,
            NOTIFY_ME_RATE_LIMIT.maxRequests,
            NOTIFY_ME_RATE_LIMIT.windowSeconds * 1000
          )
      );

      if (!ipLimit.allowed) {
        return NextResponse.json(
          {
            ok: false,
            error: "Too many attempts. Please wait a minute and try again.",
            retryAfter: ipLimit.retryAfter,
          },
          {
            status: 429,
            headers: {
              "Retry-After": String(ipLimit.retryAfter),
            },
          }
        );
      }
    }

    // 2. Request body parsing
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { ok: false, error: "Invalid request payload." },
        { status: 400 }
      );
    }

    // 3. Honeypot check (website, honeypot, hp) - silently drop bots
    const honeypotValue =
      typeof (body as any).website === "string"
        ? (body as any).website
        : typeof (body as any).honeypot === "string"
        ? (body as any).honeypot
        : typeof (body as any).hp === "string"
        ? (body as any).hp
        : "";

    if (honeypotValue.trim().length > 0) {
      log.info("Honeypot field populated; dropping submission silently");
      return NextResponse.json({
        ok: true,
        message: GENERIC_SUCCESS_MESSAGE,
      });
    }

    // 4. Validate and normalise email
    const validation = validateNotifyMeEmail((body as any).email);
    if (!validation.valid) {
      return NextResponse.json(
        { ok: false, error: validation.error || "Please enter a valid email address." },
        { status: 400 }
      );
    }

    const email = validation.email;
    const rawSource = (body as any).source;
    const source =
      typeof rawSource === "string" && rawSource.trim()
        ? rawSource.trim().slice(0, 50)
        : "pricing";
    const createdAt = new Date().toISOString();

    // 5. Cloudflare edge context resolution
    let cfEnv: Record<string, any> | undefined;
    try {
      const ctx = getRequestContext();
      if (ctx?.env) {
        cfEnv = ctx.env as Record<string, any>;
      }
    } catch {}

    // 6. Supabase client resolution (service role)
    let supabaseClient: any = null;
    if (process.env.NODE_ENV === "test" && (globalThis as any).__mockSupabaseClient !== undefined) {
      supabaseClient = (globalThis as any).__mockSupabaseClient;
    } else {
      const hasUrl = Boolean(
        getRuntimeEnv("NEXT_PUBLIC_SUPABASE_URL", cfEnv) ||
          getRuntimeEnv("SUPABASE_URL", cfEnv)
      );
      const hasKey = Boolean(
        getRuntimeEnv("SUPABASE_SERVICE_ROLE_KEY", cfEnv) ||
          getRuntimeEnv("SUPABASE_SERVICE_KEY", cfEnv) ||
          getRuntimeEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", cfEnv)
      );
      if (hasUrl && hasKey) {
        try {
          supabaseClient = getSupabaseAdminClient(cfEnv, true);
        } catch {
          supabaseClient = null;
        }
      }
    }

    if (!supabaseClient?.from) {
      log.error("Supabase admin client unavailable for notify_me_signups");
      return NextResponse.json(
        { ok: false, error: GENERIC_TRY_AGAIN_MESSAGE },
        { status: 500 }
      );
    }

    // 7. Upsert-ignore on conflict (prevent duplicate error, prevent email enumeration)
    try {
      // Pre-check for existing row to avoid unnecessary write conflict
      const { data: existingRow, error: selectError } = await supabaseClient
        .from("notify_me_signups")
        .select("id")
        .eq("email", email)
        .maybeSingle();

      if (!selectError && existingRow?.id) {
        log.info("Duplicate notify-me email submitted; ignored without error");
        return NextResponse.json({
          ok: true,
          message: GENERIC_SUCCESS_MESSAGE,
        });
      }

      const { error: insertError } = await supabaseClient
        .from("notify_me_signups")
        .insert({
          email,
          source,
          created_at: createdAt,
        });

      if (insertError) {
        // Handle Postgres unique constraint violation (code 23505) gracefully
        if (
          insertError.code === "23505" ||
          /duplicate key|unique constraint/i.test(insertError.message || "")
        ) {
          log.info("Duplicate subscriber unique index hit (23505); ignored");
          return NextResponse.json({
            ok: true,
            message: GENERIC_SUCCESS_MESSAGE,
          });
        }

        log.error("Failed to insert notify_me_signups row", {
          errorCode: insertError.code,
          errorMessage: insertError.message,
        });
        return NextResponse.json(
          { ok: false, error: GENERIC_TRY_AGAIN_MESSAGE },
          { status: 500 }
        );
      }
    } catch (dbErr: any) {
      log.error("Database operation failed in notify_me", { error: dbErr?.message });
      return NextResponse.json(
        { ok: false, error: GENERIC_TRY_AGAIN_MESSAGE },
        { status: 500 }
      );
    }

    // Generic success response returned either way (no email enumeration, no mail sent)
    return NextResponse.json({
      ok: true,
      message: GENERIC_SUCCESS_MESSAGE,
    });
  } catch (_err) {
    reportRequestErrorToSentry(req, _err);
    return NextResponse.json(
      { ok: false, error: GENERIC_TRY_AGAIN_MESSAGE },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  return measureRouteBudget("/api/notify-me", () => postHandler(req));
}
