import { NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { verifyAdminSession } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/auditLog";
import {
  listPendingEarlyAccessRequests,
  approveEarlyAccessRequest,
  rejectEarlyAccessRequest,
} from "@/lib/admin/earlyAccess";

import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";

export const runtime = "edge";

export async function GET(req: Request) {
  const auth = await verifyAdminSession(req);
  if (!auth.isAdmin || !auth.user) {
    return NextResponse.json(
      { error: "Forbidden: Admin access only." },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get("page") || "1", 10);
  const limit = parseInt(
    searchParams.get("limit") || searchParams.get("pageSize") || "25",
    10
  );
  const status = searchParams.get("status") || "pending";

  try {
    const result = await listPendingEarlyAccessRequests({
      page,
      limit,
      status,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error || "Failed to retrieve early-access requests" },
        { status: 500 }
      );
    }

    // Audit: an admin just read the early-access list (emails = PII).
    // Fail-open logger; never blocks the response.
    await logAdminAction({
      adminUserId: auth.user.id,
      action: "pii_read",
      targetType: "early_access_list",
      metadata: { page, limit, status, total: result.total },
      request: req,
    });

    return NextResponse.json({
      ok: true,
      requests: result.requests,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    });
  } catch (err: any) {
    reportRequestErrorToSentry(req, err);
    return NextResponse.json(
      { error: err?.message || "Internal server error" },
      { status: 500 }
    );
  }
}

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
    const { action, email, reason } = body || {};

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return NextResponse.json(
        { error: "Valid email is required" },
        { status: 400 }
      );
    }

    if (action !== "approve" && action !== "reject") {
      return NextResponse.json(
        { error: "action must be 'approve' or 'reject'" },
        { status: 400 }
      );
    }

    // Always derive admin identifier from verified session - NEVER trust client role/body
    const adminEmail = auth.user.email || auth.user.id;

    if (action === "approve") {
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
    } else {
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
    }
  } catch (err: any) {
    reportRequestErrorToSentry(req, err);
    return NextResponse.json(
      { error: err?.message || "Internal server error" },
      { status: 500 }
    );
  }
}
