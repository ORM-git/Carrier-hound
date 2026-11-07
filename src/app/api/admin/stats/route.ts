import { NextResponse } from "next/server";
import { verifyAdminSession } from "@/lib/admin/auth";
import { getAnalyticsStats } from "@/lib/admin/analytics";

import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";

export const runtime = "edge";

export async function GET(req: Request) {
  const auth = await verifyAdminSession(req);
  if (!auth.isAdmin) {
    return NextResponse.json(
      { error: "Forbidden: Admin access only." },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(req.url);
  const daysParam = searchParams.get("days");
  const days = daysParam === "30" ? 30 : 7;

  try {
    const stats = await getAnalyticsStats(days);
    return NextResponse.json({ ok: true, stats });
  } catch (err: any) {
    reportRequestErrorToSentry(req, err);
    return NextResponse.json(
      { error: err?.message || "Failed to retrieve analytics stats" },
      { status: 500 }
    );
  }
}
