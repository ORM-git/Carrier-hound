import { NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { verifyAdminSession } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/auditLog";
import { approveEarlyAccessRequest } from "@/lib/admin/earlyAccess";

export const runtime = "edge";

export async function POST(req: Request) {
  const auth = await verifyAdminSession(req);
  if (!auth.isAdmin || !auth.user) {
    return NextResponse.json(
      { error: "Forbidden: Admin access only." },
      { status: 403 }
    );
  }

  let cfEnv: Record<string, any> | undefined;
  try {
    const ctx = getRequestContext();
    if (ctx?.env) {
      cfEnv = ctx.env as Record<string, any>;
    }
  } catch {}

  try {
    const body = await req.json().catch(() => ({}));
    const { email } = body || {};

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return NextResponse.json(
        { error: "Valid email is required" },
        { status: 400 }
      );
    }

    // Server-side admin verification only - never trust client role or payload
    const adminEmail = auth.user.email || auth.user.id;

    const result = await approveEarlyAccessRequest({
      adminEmail,
      targetEmail: email,
      cfEnv,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error || "Failed to approve early access request" },
        { status: 500 }
      );
    }

    await logAdminAction({
      adminUserId: auth.user.id,
      action: "early_access.approve",
      targetType: "early_access",
      targetId: result.email,
      metadata: {
        email: result.email,
        notify_skipped: result.notify_skipped,
        already_approved: Boolean(result.already_approved),
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
