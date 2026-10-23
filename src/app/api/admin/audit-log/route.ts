import { NextResponse } from "next/server";
import { verifyAdminSession } from "@/lib/admin/auth";
import { fetchAdminAuditLogs } from "@/lib/admin/auditLog";

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
  const pageParam = parseInt(searchParams.get("page") || "1", 10);
  const pageSizeParam = parseInt(searchParams.get("pageSize") || "20", 10);
  const actionParam = searchParams.get("action") || undefined;

  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;
  const pageSize = Number.isInteger(pageSizeParam) && pageSizeParam > 0 && pageSizeParam <= 100
    ? pageSizeParam
    : 20;

  try {
    const result = await fetchAdminAuditLogs({
      page,
      pageSize,
      action: actionParam,
    });

    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (err: any) {
    console.error("[Admin API /audit-log] Error:", err?.message || err);
    return NextResponse.json(
      { error: "Failed to retrieve audit logs" },
      { status: 500 }
    );
  }
}
