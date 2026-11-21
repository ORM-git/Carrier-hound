import { NextResponse } from "next/server";
import { verifyAdminSession, getSupabaseAdmin } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/auditLog";
import { groupErrorEvents, type StoredErrorEvent } from "@/lib/monitoring/errorEvents";
import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";

export const runtime = "edge";

const WINDOW_DAYS = 7;
// shortcut: groups in memory over at most this many recent rows; move to a SQL view/RPC if error volume outgrows it.
const MAX_ROWS = 5000;
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: Request) {
  const auth = await verifyAdminSession(req);
  if (!auth.isAdmin) {
    return NextResponse.json({ error: "Forbidden: Admin access only." }, { status: 403, headers: NO_STORE });
  }

  try {
    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await getSupabaseAdmin()
      .from("error_events")
      .select("occurred_at, route, error_message, stack_hash, count")
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(MAX_ROWS);
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as StoredErrorEvent[];
    const groups = groupErrorEvents(rows);

    // Audit: admin read of the error log. user_id is never selected, so this is not a pii_read. Fail-open logger.
    if (auth.user) {
      await logAdminAction({
        adminUserId: auth.user.id,
        action: "error_events_read",
        targetType: "error_events",
        metadata: { days: WINDOW_DAYS, group_count: groups.length, row_count: rows.length },
        request: req,
      });
    }

    return NextResponse.json({
      ok: true,
      days: WINDOW_DAYS,
      truncated: rows.length === MAX_ROWS,
      groups,
    }, { headers: NO_STORE });
  } catch (err: any) {
    reportRequestErrorToSentry(req, err);
    return NextResponse.json(
      { error: err?.message || "Failed to retrieve error events" },
      { status: 500, headers: NO_STORE }
    );
  }
}
