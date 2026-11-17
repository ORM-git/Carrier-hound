import { NextResponse } from "next/server";
import { getSupabaseAdminClient, getClientIpFromRequest } from "@/lib/ai/serviceHandler";
import { checkSharedRateLimit } from "@/lib/api/sharedRateLimit";
import {
  validateResumeBuffer,
  extractTextFromResumeBuffer,
  extractSkillsFromText,
} from "@/lib/onboarding/step2Resume";
import { isOnboardingStep2Active } from "@/config/onboarding";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { route: "/api/onboarding/resume" } });

// Edge runtime with streaming form-data or nodejs runtime
export const runtime = "nodejs";

export async function POST(req: Request) {
  // Check feature flag: fail-closed with 503 if disabled
  if (!isOnboardingStep2Active()) {
    return NextResponse.json(
      { error: "Feature is coming soon", code: "FEATURE_COMING_SOON" },
      { status: 503 }
    );
  }

  let cfEnv: Record<string, any> | undefined;
  try {
    const ctx = getRequestContext();
    if (ctx?.env) cfEnv = ctx.env as Record<string, any>;
  } catch {}

  // 1. Authenticate user
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized: Missing authentication token" }, { status: 401 });
  }

  const token = authHeader.replace("Bearer ", "").trim();
  const supabaseAdmin = getSupabaseAdminClient(cfEnv, true);

  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized: Invalid session" }, { status: 401 });
  }

  // 2. Rate limit: max 10 resume uploads per hour per user / IP
  const clientIp = getClientIpFromRequest(req);
  const rateLimitKey = `rate:onboarding:resume:${user.id}:${clientIp}`;
  const rateCheck = await checkSharedRateLimit(rateLimitKey, 10, 3600);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: "Too many upload attempts. Please wait before uploading another resume." },
      { status: 429 }
    );
  }

  // 3. Parse multipart form data
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid form data. Please upload a valid multipart document." },
      { status: 400 }
    );
  }

  const file = formData.get("file");
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json(
      { error: "No resume file provided. Please select a PDF or DOCX document." },
      { status: 400 }
    );
  }

  const rawFilename = (file as any).name || "resume.pdf";
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // 4. Validate file size and real file type via magic bytes
  const validation = validateResumeBuffer(buffer, rawFilename, file.size);
  if (!validation.valid || !validation.type) {
    return NextResponse.json(
      { error: validation.error || "Invalid file format or corrupted document." },
      { status: 400 }
    );
  }

  const sanitizedFilename = validation.sanitizedFilename;
  const fileType = validation.type;

  // 5. Store file in private Supabase storage bucket (resumes) tied to user (no public URL)
  const storagePath = `${user.id}/${Date.now()}-${sanitizedFilename}`;
  const mimeType =
    fileType === "pdf"
      ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  try {
    const { error: uploadError } = await supabaseAdmin.storage
      .from("resumes")
      .upload(storagePath, buffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (uploadError) {
      log.warn("Private resume storage upload failed (will continue with parsed profile)", {
        userId: user.id,
        error: uploadError.message,
      });
    }
  } catch (err: any) {
    log.warn("Storage upload exception", { userId: user.id, error: err?.message });
  }

  // 6. Extract text on the server (never log extracted text!)
  let extractedText = "";
  try {
    extractedText = await extractTextFromResumeBuffer(buffer, fileType);
  } catch (extractErr: any) {
    return NextResponse.json(
      { error: extractErr?.message || "Failed to parse document text. Please ensure the file is not corrupted." },
      { status: 422 }
    );
  }

  // 7. Extract skills deterministically using taxonomy
  const detectedSkills = extractSkillsFromText(extractedText);

  // 8. Save extracted text, filename, and skills on the profile
  try {
    const now = new Date().toISOString();

    // Upsert into candidate_profiles
    await supabaseAdmin
      .from("candidate_profiles")
      .upsert(
        {
          user_id: user.id,
          raw_resume_text: extractedText,
          resume_filename: sanitizedFilename,
          skills: detectedSkills,
          confirmed_at: now,
          updated_at: now,
        },
        { onConflict: "user_id" }
      );

    // Also update public.profiles
    await supabaseAdmin
      .from("profiles")
      .update({
        resume_filename: sanitizedFilename,
      })
      .eq("user_id", user.id);

    // Strictly metadata logging - NEVER log resume text
    log.info("Resume uploaded and processed successfully", {
      userId: user.id,
      filename: sanitizedFilename,
      sizeBytes: buffer.length,
      fileType,
      skillsCount: detectedSkills.length,
    });

    return NextResponse.json({
      ok: true,
      filename: sanitizedFilename,
      skillsCount: detectedSkills.length,
      skills: detectedSkills.slice(0, 15),
    });
  } catch (err: any) {
    log.error("Failed to persist parsed resume to candidate profile", {
      userId: user.id,
      error: err?.message,
    });
    return NextResponse.json(
      { error: "Failed to save profile. Please try again." },
      { status: 500 }
    );
  }
}
