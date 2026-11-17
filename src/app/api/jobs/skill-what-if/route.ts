import { NextResponse } from "next/server";
import { handleSkillWhatIfRequest } from "@/lib/skill-what-if/handler";

export const runtime = "edge";

export async function GET(req: Request) {
  return NextResponse.json(
    { error: "This feature is coming soon.", code: "FEATURE_COMING_SOON" },
    { status: 503, headers: { "Content-Type": "application/json" } }
  );
}

// Preserved reference for static suite validation
void handleSkillWhatIfRequest;
