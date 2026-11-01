import { NextResponse } from "next/server";
import { verifyAdminSession } from "@/lib/admin/auth";
import { setUserBlockStatus } from "@/lib/admin/analytics";
import { logAdminAction } from "@/lib/admin/auditLog";

export const runtime = "edge";

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
    const { userId, action, reason } = body;

    if (!userId || typeof userId !== "string") {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 }
      );
    }

    if (action !== "block" && action !== "unblock") {
      return NextResponse.json(
        { error: "action must be 'block' or 'unblock'" },
        { status: 400 }
      );
    }

    // Safety guard: Cannot block the admin himself!
    if (auth.user?.id === userId) {
      return NextResponse.json(
        { error: "Admin cannot block themselves." },
        { status: 400 }
      );
    }

    const shouldBlock = action === "block";
    const result = await setUserBlockStatus(userId, shouldBlock, reason);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Failed to update user block status" },
        { status: 500 }
      );
    }

    // Log successful administrative mutation
    await logAdminAction({
      adminUserId: auth.user!.id,
      action: shouldBlock ? "user.block" : "user.unblock",
      targetType: "user",
      targetId: userId,
      metadata: reason ? { reason } : {},
      request: req,
    });

    return NextResponse.json({
      ok: true,
      userId,
      isBlocked: result.isBlocked,
      message: shouldBlock
        ? "User successfully blocked. Their access and active sessions have been revoked."
        : "User successfully unblocked. Access restored.",
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Internal server error" },
      { status: 500 }
    );
  }
}
