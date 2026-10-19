import { NextResponse } from "next/server";
import { recordPageView } from "@/lib/admin/analytics";

export const runtime = "edge";

async function sha256Hex16(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

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
    const ipHash = await sha256Hex16(`${ip}_careermonke_salt`);

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
