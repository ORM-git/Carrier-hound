import { NextResponse } from "next/server";
import { verifyAdminSession, getSupabaseAdmin } from "@/lib/admin/auth";
import { replayFailedEvents } from "@/lib/events/failedEvents";

import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";

export const runtime = "edge";

/**
 * GET /api/admin/replay
 * Protected admin-only endpoint to inspect the failed_events dead-letter queue.
 */
export async function GET(req: Request) {
  const auth = await verifyAdminSession(req);
  if (!auth.isAdmin) {
    return NextResponse.json(
      { error: "Forbidden: Admin access only." },
      { status: 403 }
    );
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 100);
    const status = searchParams.get("status") || "pending";
    const source = searchParams.get("source");

    let query = supabaseAdmin
      .from("failed_events")
      .select("id, source, event_id, error, attempts, status, first_failed_at, last_attempt_at, next_retry_at")
      .order("first_failed_at", { ascending: false })
      .limit(limit);

    if (status !== "all") {
      query = query.eq("status", status);
    }
    if (source) {
      query = query.eq("source", source);
    }

    const { data: items, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, items: items || [] });
  } catch (err: any) {
    reportRequestErrorToSentry(req, err);
    return NextResponse.json(
      { error: err?.message || "Failed to inspect dead-letter queue" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/replay
 * Protected admin-only endpoint to trigger replay of pending failed events.
 * Retries with exponential backoff, max 5 attempts -> dead state.
 * Strictly reuses webhook_events idempotency to prevent double fulfillment.
 */
export async function POST(req: Request) {
  const auth = await verifyAdminSession(req);
  if (!auth.isAdmin) {
    return NextResponse.json(
      { error: "Forbidden: Admin access only." },
      { status: 403 }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const summary = await replayFailedEvents({
      limit: body.limit,
      eventId: body.eventId,
      source: body.source,
      sources: body.sources,
      force: body.force ?? true,
      maxAttempts: body.maxAttempts ?? 5,
    });

    return NextResponse.json(summary);
  } catch (err: any) {
    reportRequestErrorToSentry(req, err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to replay dead-letter events" },
      { status: 500 }
    );
  }
}
