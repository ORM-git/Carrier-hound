import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/ai/serviceHandler";
import { processUnsubscribe } from "@/lib/email/unsubscribe";

export const runtime = "edge";

/**
 * GET /api/email/unsubscribe?token=<signed_token>
 * One-click unsubscribe endpoint via browser link click.
 * No login required; cryptographically verified via HMAC token.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");

    if (!token) {
      return NextResponse.json(
        { ok: false, error: "Missing required 'token' parameter." },
        { status: 400 }
      );
    }

    let supabaseAdmin: any;
    try {
      supabaseAdmin = getSupabaseAdminClient(undefined, true);
    } catch (_err: any) {
      return NextResponse.json(
        { ok: false, error: "Database configuration unavailable." },
        { status: 500 }
      );
    }

    const result = await processUnsubscribe(supabaseAdmin, token);

    return NextResponse.json(
      {
        ok: result.ok,
        message: result.message,
        email: result.email,
        topic: result.topic,
        error: result.ok ? undefined : result.message,
      },
      { status: result.status }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Internal unsubscribe error." },
      { status: 500 }
    );
  }
}

/**
 * POST /api/email/unsubscribe
 * RFC 8058 One-Click Unsubscribe endpoint (List-Unsubscribe=One-Click).
 * Email user-agents execute automated POST with token in query or body.
 */
export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    let token = url.searchParams.get("token");

    // Also support token passed in JSON body or form-data body
    if (!token) {
      const contentType = req.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        try {
          const body = await req.json();
          token = body?.token;
        } catch {}
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        try {
          const text = await req.text();
          const params = new URLSearchParams(text);
          token = params.get("token");
        } catch {}
      }
    }

    if (!token) {
      return NextResponse.json(
        { ok: false, error: "Missing required 'token' parameter." },
        { status: 400 }
      );
    }

    let supabaseAdmin: any;
    try {
      supabaseAdmin = getSupabaseAdminClient(undefined, true);
    } catch (_err: any) {
      return NextResponse.json(
        { ok: false, error: "Database configuration unavailable." },
        { status: 500 }
      );
    }

    const result = await processUnsubscribe(supabaseAdmin, token);

    return NextResponse.json(
      {
        ok: result.ok,
        unsubscribed: result.ok,
        message: result.message,
        email: result.email,
        topic: result.topic,
        error: result.ok ? undefined : result.message,
      },
      { status: result.status }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Internal unsubscribe error." },
      { status: 500 }
    );
  }
}
