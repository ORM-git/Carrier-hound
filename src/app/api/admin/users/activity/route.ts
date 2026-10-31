import { NextResponse } from "next/server";
import { verifyAdminSession } from "@/lib/admin/auth";
import { getUserActivityLogs } from "@/lib/admin/analytics";

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
  const userId = searchParams.get("userId");

  if (!userId) {
    return NextResponse.json(
      { error: "userId parameter is required" },
      { status: 400 }
    );
  }

  try {
    const activity = await getUserActivityLogs(userId);

    // Compute read-only usage summary for 24h and 7d from recorded page views
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    let views24h = 0;
    let views7d = 0;

    for (const item of activity) {
      const itemTime = new Date(item.created_at).getTime();
      if (itemTime >= oneDayAgo) views24h++;
      if (itemTime >= sevenDaysAgo) views7d++;
    }

    return NextResponse.json({
      ok: true,
      activity,
      summary: {
        views24h,
        views7d,
        totalRecordedViews: activity.length,
      },
      telemetryNotice: {
        untrackedSearches: "Searches are executed stateless or by IP rate limiter; per-user search events are not tracked in database.",
        untrackedApplyClicks: "Job external apply clicks are not logged to a user-associated table.",
        untrackedAiCalls: "Granular AI prompt/completion histories are not tracked in page_views schema.",
      },
    });
  } catch (err: any) {
    console.error("[Admin API /users/activity] Error:", err?.message || err);
    return NextResponse.json(
      { error: "Failed to retrieve user activity" },
      { status: 500 }
    );
  }
}
