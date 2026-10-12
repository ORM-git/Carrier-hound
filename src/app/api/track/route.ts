import { NextResponse } from "next/server";
import crypto from "crypto";
import { recordPageView } from "@/lib/admin/analytics";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { path, referrer, userId } = body;

    if (!path || typeof path !== "string") {
      return NextResponse.json({ ok: false, error: "Invalid path" }, { status: 400 });
    }

    // Extract headers for anonymous unique visitor metrics
    const forwarded = req.headers.get("x-forwarded-for") || "";
    const ip = forwarded.split(",")[0].trim() || req.headers.get("x-real-ip") || "127.0.0.1";
    const userAgent = req.headers.get("user-agent") || "";

    // Salted anonymous IP hash (non-reversible)
    const ipHash = crypto
      .createHash("sha256")
      .update(`${ip}_careermonke_salt`)
      .digest("hex")
      .slice(0, 16);

    // Fire and record
    await recordPageView({
      path,
      referrer: referrer || null,
      userId: userId || null,
      ipHash,
      userAgent: userAgent ? userAgent.slice(0, 255) : null,
      createdAt: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    // Fail silently to never break client page experience
    return NextResponse.json({ ok: true, fallback: true });
  }
}
