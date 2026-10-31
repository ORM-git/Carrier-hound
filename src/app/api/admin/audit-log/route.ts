import { NextResponse } from "next/server";
import { verifyAdminSession } from "@/lib/admin/auth";
import { fetchAdminAuditLogs } from "@/lib/admin/auditLog";

export const runtime = "edge";

export async function GET(req: Request) {
  const auth = await verifyAdminSession(req);
  if (!auth.isAdmin) {
    return NextResponse.json(
      { ok: false, error: "Forbidden: Admin access only." },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(req.url);
  const actionParam = searchParams.get("action") || undefined;

  // Validate page parameter
  let page = 1;
  if (searchParams.has("page")) {
    const rawPage = searchParams.get("page");
    const parsedPage = Number(rawPage);
    if (!Number.isInteger(parsedPage) || parsedPage < 1) {
      return NextResponse.json(
        { ok: false, error: "Invalid 'page' parameter: must be a positive integer >= 1" },
        { status: 400 }
      );
    }
    page = parsedPage;
  }

  // Validate pageSize parameter (default: 20, max: 100)
  let pageSize = 20;
  if (searchParams.has("pageSize")) {
    const rawPageSize = searchParams.get("pageSize");
    const parsedPageSize = Number(rawPageSize);
    if (!Number.isInteger(parsedPageSize) || parsedPageSize < 1 || parsedPageSize > 100) {
      return NextResponse.json(
        { ok: false, error: "Invalid 'pageSize' parameter: must be an integer between 1 and 100" },
        { status: 400 }
      );
    }
    pageSize = parsedPageSize;
  }

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
      { ok: false, error: "Failed to retrieve audit logs from database" },
      { status: 500 }
    );
  }
}
