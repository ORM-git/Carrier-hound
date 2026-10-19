import { NextResponse } from "next/server";
import { verifyAdminSession } from "@/lib/admin/auth";
import { getUsersManagementList } from "@/lib/admin/analytics";

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
    return NextResponse.json({ ok: true, users });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to retrieve users list" },
      { status: 500 }
    );
  }
}
