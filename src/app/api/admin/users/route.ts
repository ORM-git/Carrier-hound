import { NextResponse } from "next/server";
import { verifyAdminSession } from "@/lib/admin/auth";
import { getPaginatedUsersManagementList } from "@/lib/admin/analytics";

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
  const q = searchParams.get("q") || "";

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

  // Validate pageSize parameter (default: 25, max: 100)
  let pageSize = 25;
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
    const result = await getPaginatedUsersManagementList({
      page,
      pageSize,
      searchQuery: q,
    });

    return NextResponse.json({
      ok: true,
      users: result.users,
      pagination: result.pagination,
      searchNotice: result.searchNotice,
    });
  } catch (err: any) {
    console.error("[Admin API /users] Error:", err?.message || err);
    return NextResponse.json(
      { ok: false, error: "Failed to retrieve users list" },
      { status: 500 }
    );
  }
}
