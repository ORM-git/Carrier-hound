import { NextResponse } from "next/server";
import { verifyAdminSession } from "@/lib/admin/auth";
import { getUserActivityLogs } from "@/lib/admin/analytics";

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
    return NextResponse.json({ ok: true, activity });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to retrieve user activity" },
      { status: 500 }
    );
  }
}
