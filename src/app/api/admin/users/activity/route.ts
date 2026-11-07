import { NextResponse } from "next/server";
import { verifyAdminSession } from "@/lib/admin/auth";
import { getUserActivityLogs } from "@/lib/admin/analytics";
import { logAdminAction } from "@/lib/admin/auditLog";

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
  const userId = searchParams.get("userId");

  if (!userId) {
    return NextResponse.json(
      { error: "userId parameter is required" },
      { status: 400 }
    );
  }

  try {
    const activity = await getUserActivityLogs(userId);

    // Audit: an admin just read one user's activity (PII). Fail-open logger;
    // never blocks the response. DB row: user data access audit.
    if (auth.user) {
      await logAdminAction({
        adminUserId: auth.user.id,
        action: "pii_read",
        targetType: "user",
        targetId: userId,
        metadata: { log_count: Array.isArray(activity) ? activity.length : null },
        request: req,
      });
    }

    return NextResponse.json({ ok: true, activity });
  } catch (err: any) {
    reportRequestErrorToSentry(req, err);
    return NextResponse.json(
      { error: err?.message || "Failed to retrieve user activity" },
      { status: 500 }
    );
  }
}
