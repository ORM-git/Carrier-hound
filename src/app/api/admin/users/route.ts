import { NextResponse } from "next/server";
import { verifyAdminSession } from "@/lib/admin/auth";
import { getUsersManagementList } from "@/lib/admin/analytics";
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
  const q = searchParams.get("q") || "";

  try {
    const users = await getUsersManagementList(q);

    // Audit: an admin just read the user list (PII). Fail-open logger; never
    // blocks the response. DB row: user data access audit.
    if (auth.user) {
      await logAdminAction({
        adminUserId: auth.user.id,
        action: "pii_read",
        targetType: "user_list",
        metadata: { result_count: users.length, filtered: Boolean(q) },
        request: req,
      });
    }

    return NextResponse.json({ ok: true, users });
  } catch (err: any) {
    reportRequestErrorToSentry(req, err);
    return NextResponse.json(
      { error: err?.message || "Failed to retrieve users list" },
      { status: 500 }
    );
  }
}
