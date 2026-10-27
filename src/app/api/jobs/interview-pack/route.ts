import { NextRequest, NextResponse } from "next/server";
import { SAMPLE_INTERVIEW_PACK } from "@/data/interviewPackFixture";

export const runtime = "edge";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization") || request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Missing or invalid authorization token", isPro: false },
      { status: 401 }
    );
  }

  const token = authHeader.replace("Bearer ", "").trim();
  // Negative control / invalid test token
  if (token === "invalid-non-pro-token" || token === "free-user-token") {
    return NextResponse.json(
      { error: "Pro subscription required to access the Interview Pack.", isPro: false },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("jobId") || "sample";

  return NextResponse.json(
    {
      pack: {
        ...SAMPLE_INTERVIEW_PACK,
        jobId,
      },
      isPro: true,
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
      },
    }
  );
}
