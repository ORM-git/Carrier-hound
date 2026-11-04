import { NextResponse } from "next/server";
import { verifyAdminSession } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/auditLog";
import { rejectEarlyAccessRequest } from "@/lib/admin/earlyAccess";

export const runtime = "edge";

export async function POST(req: Request) {
  const auth = await verifyAdminSession(req);
  if (!auth.isAdmin || !auth.user) {
    return NextResponse.json(
      { error: "Forbidden: Admin access only." },
      { status: 403 }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { email, reason } = body || {};

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return NextResponse.json(
        { error: "Valid email is required" },
        { status: 400 }
      );
    }

    // Server-side admin verification only - never trust client role or payload
    const adminEmail = auth.user.email || auth.user.id;

    const result = await rejectEarlyAccessRequest({
      adminEmail,
      targetEmail: email,
      reason,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error || "Failed to reject early access request" },
        { status: 500 }
      );
    }

    await logAdminAction({
      adminUserId: auth.user.id,
      action: "early_access.reject",
      targetType: "early_access",
      targetId: result.email,
      metadata: {
        email: result.email,
        reason,
        already_rejected: Boolean(result.already_rejected),
      },
      request: req,
    });

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Internal server error" },
      { status: 500 }
    );
  }
}
