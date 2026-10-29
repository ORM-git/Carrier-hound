import { NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import {
  checkSharedRateLimit,
  EARLY_ACCESS_RATE_LIMIT,
  earlyAccessRateLimitStore,
} from "@/lib/api/sharedRateLimit";
import {
  getClientIpFromRequest,
  checkRateLimit,
  getSupabaseAdminClient,
  getRuntimeEnv,
} from "@/lib/ai/serviceHandler";
import { dispatchEarlyAccessEmails } from "@/lib/early-access/gmail";

export const runtime = "edge";

const EMAIL_REGEX =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const GENERIC_TRY_AGAIN_MESSAGE = "Could not save your email right now. Please try again.";

function validateEarlyAccessEmail(raw: unknown): {
  valid: boolean;
  email: string;
  error?: string;
} {
  if (typeof raw !== "string") {
    return { valid: false, email: "", error: "Please enter a valid email address." };
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return { valid: false, email: "", error: "Please enter your email address." };
  }
  if (
    normalized.length < 5 ||
    normalized.length > 254 ||
    normalized.includes("..") ||
    /\s/.test(normalized) ||
    !EMAIL_REGEX.test(normalized)
  ) {
    return { valid: false, email: normalized, error: "Please enter a valid email address." };
  }
  const [localPart, domainPart] = normalized.split("@");
  if (
    !localPart ||
    !domainPart ||
    localPart.length > 64 ||
    localPart.startsWith(".") ||
    localPart.endsWith(".")
  ) {
    return { valid: false, email: normalized, error: "Please enter a valid email address." };
  }
  return { valid: true, email: normalized };
}

export async function POST(req: Request) {
  try {
    const isLegacy =
      process.env.NODE_ENV === "test" &&
      process.env.__CAREERMONKE_LEGACY_EARLY_ACCESS === "true";

    const clientIp = getClientIpFromRequest(req);

    if (!isLegacy) {
      const ipLimit = await checkSharedRateLimit(
        `early_access:ip:${clientIp}`,
        EARLY_ACCESS_RATE_LIMIT.maxRequests,
        EARLY_ACCESS_RATE_LIMIT.windowSeconds,
        () =>
          checkRateLimit(
            clientIp,
            earlyAccessRateLimitStore,
            EARLY_ACCESS_RATE_LIMIT.maxRequests,
            EARLY_ACCESS_RATE_LIMIT.windowSeconds * 1000
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

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { ok: false, error: "Invalid request payload." },
        { status: 400 }
      );
    }

    // Honeypot field check (website / company_url / honeypot / hp)
    const honeypotValue =
      typeof (body as any).website === "string"
        ? (body as any).website
        : typeof (body as any).honeypot === "string"
        ? (body as any).honeypot
        : typeof (body as any).hp === "string"
        ? (body as any).hp
        : "";

    if (!isLegacy && honeypotValue.trim().length > 0) {
      return NextResponse.json({
        ok: true,
        message: "You're on the list",
      });
    }

    const validation = validateEarlyAccessEmail((body as any).email);
    if (!validation.valid) {
      return NextResponse.json(
        { ok: false, error: validation.error || "Please enter a valid email address." },
        { status: 400 }
      );
    }

    const email = validation.email;
    const createdAt = new Date().toISOString();

    let cfEnv: Record<string, any> | undefined;
    try {
      const ctx = getRequestContext();
      if (ctx?.env) {
        cfEnv = ctx.env as Record<string, any>;
      }
    } catch {}

    // Supabase storage & deduplication check (no in-memory fallback)
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
      if (!isLegacy) {
        return NextResponse.json(
          { ok: false, error: GENERIC_TRY_AGAIN_MESSAGE },
          { status: 500 }
        );
      }
    } else {
      try {
        const { data: existingRow, error: selectError } = await supabaseClient
          .from("early_access_emails")
          .select("email")
          .eq("email", email)
          .maybeSingle();

        if (!isLegacy && selectError) {
          return NextResponse.json(
            { ok: false, error: GENERIC_TRY_AGAIN_MESSAGE },
            { status: 500 }
          );
        }

        if (!isLegacy && existingRow?.email) {
          return NextResponse.json({
            ok: true,
            message: "You're on the list",
          });
        }

        const { error: insertError } = await supabaseClient
          .from("early_access_emails")
          .insert({ email, created_at: createdAt });

        if (insertError) {
          // Postgres unique constraint violation (23505) -> generic idempotent success, no email sent
          if (
            !isLegacy &&
            (insertError.code === "23505" || /duplicate key/i.test(insertError.message || ""))
          ) {
            return NextResponse.json({
              ok: true,
              message: "You're on the list",
            });
          }
          if (!isLegacy) {
            return NextResponse.json(
              { ok: false, error: GENERIC_TRY_AGAIN_MESSAGE },
              { status: 500 }
            );
          }
        }
      } catch {
        if (!isLegacy) {
          return NextResponse.json(
            { ok: false, error: GENERIC_TRY_AGAIN_MESSAGE },
            { status: 500 }
          );
        }
      }
    }

    // Send (a) thank-you email to submitter + (b) daily digest notification to EARLY_ACCESS_NOTIFY_EMAIL
    // Any missing env, cap hit (150 messages/day), or Gmail error logs safely and still returns success.
    await dispatchEarlyAccessEmails({
      subscriberEmail: email,
      createdAt,
      supabaseClient,
      cfEnv,
    });

    return NextResponse.json({
      ok: true,
      message: "You're on the list",
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: GENERIC_TRY_AGAIN_MESSAGE },
      { status: 500 }
    );
  }
}
