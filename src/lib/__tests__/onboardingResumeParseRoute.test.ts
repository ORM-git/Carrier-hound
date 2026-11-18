/**
 * POST /api/onboarding/resume end to end with real text extraction and parsing:
 * the upload is stored, then parsed into public.onboarding_resume_profiles, and every
 * parse failure still returns 200 so the user can continue.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

const state = vi.hoisted(() => ({
  admin: null as any,
  executeAiCore: null as any,
}));

vi.mock("@/lib/ai/serviceHandler", () => ({
  getSupabaseAdminClient: vi.fn(() => state.admin),
  getClientIpFromRequest: (req: Request) => req.headers.get("cf-connecting-ip") || "anonymous-client",
  executeAiCore: (...args: unknown[]) => state.executeAiCore(...args),
}));
vi.mock("@cloudflare/next-on-pages", () => ({
  getRequestContext: vi.fn(() => undefined),
}));

import { POST } from "@/app/api/onboarding/resume/route";
import { RESUME_MIME } from "@/lib/onboarding/step2Resume";

const FLAG = "NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED";
const USER_ID = "11111111-2222-3333-4444-555555555555";
const FIX = path.join(process.cwd(), "tests/fixtures/onboarding-resume");
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIX, name)));

function makeAdmin(opts: { profileUpsertError?: any } = {}) {
  const tables: Record<string, Map<string, any>> = {
    onboarding_resume_uploads: new Map(),
    onboarding_resume_profiles: new Map(),
  };
  const admin = {
    tables,
    auth: {
      getUser: vi.fn(async (t: string) =>
        t === "good" ? { data: { user: { id: USER_ID } }, error: null } : { data: { user: null }, error: { message: "bad" } }
      ),
    },
    from: vi.fn((table: string) => ({
      select: () => ({
        eq: (_c: string, id: string) => ({
          maybeSingle: async () => ({ data: tables[table]?.get(id) ?? null, error: null }),
        }),
      }),
      upsert: async (row: any) => {
        if (table === "onboarding_resume_profiles" && opts.profileUpsertError) return { error: opts.profileUpsertError };
        tables[table].set(row.user_id, { ...row });
        return { error: null };
      },
    })),
    storage: {
      from: () => ({
        upload: vi.fn(async () => ({ error: null })),
        remove: vi.fn(async () => ({ error: null })),
      }),
    },
    rpc: vi.fn(async () => ({ data: [], error: null })),
  };
  return admin;
}

function uploadRequest(bytes: Uint8Array, name: string, type: string, token = "good") {
  const form = new FormData();
  form.append("file", new File([bytes as unknown as BlobPart], name, { type }));
  return new Request("https://app.test/api/onboarding/resume", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "203.0.113.9" },
    body: form,
  });
}

vi.mock("@/lib/api/sharedRateLimit", () => ({
  checkSharedRateLimitStrict: vi.fn(async () => ({ allowed: true, retryAfter: 0, source: "shared" })),
}));

beforeEach(() => {
  process.env[FLAG] = "true";
  state.admin = makeAdmin();
  state.executeAiCore = vi.fn(async () => ({ statusCode: 403, body: { code: "PRO_REQUIRED" } }));
});
afterEach(() => {
  delete process.env[FLAG];
});

describe("POST /api/onboarding/resume parses the upload for ranking", () => {
  it("LinkedIn 'Save to PDF' export: stored, parsed by rules (non-Pro), saved privately for the owner", async () => {
    const res = await POST(uploadRequest(fixture("linkedin-style.pdf"), "Profile.pdf", RESUME_MIME.pdf));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.parse).toMatchObject({ status: "parsed", source: "rules", jobTitle: "Senior Data Analyst" });
    expect(body.parse.topSkills).toEqual(["Python", "SQL", "Tableau"]);

    const pointer = state.admin.tables.onboarding_resume_uploads.get(USER_ID);
    const row = state.admin.tables.onboarding_resume_profiles.get(USER_ID);
    expect(row).toMatchObject({ user_id: USER_ID, parse_status: "parsed", parse_source: "rules", source_storage_path: pointer.storage_path });
    expect(row.profile.jobTitles).toEqual(["Senior Data Analyst", "Data Analyst"]);
    expect(row.profile.location).toBe("Bengaluru, Karnataka, India");
    // No raw text and no contact data are stored
    expect(JSON.stringify(row)).not.toMatch(/Priya|linkedin\.com|rawText/);
  });

  it("goes through the existing AI pipeline with the user's token and IP, and uses its result on 200", async () => {
    state.executeAiCore = vi.fn(async () => ({
      statusCode: 200,
      body: { success: true, result: { skills: ["React", "Storybook"], experience: [{ role: "Frontend Engineer", startDate: "Jan 2020", endDate: "Present" }] } },
    }));
    const res = await POST(uploadRequest(fixture("resume.docx"), "cv.docx", RESUME_MIME.docx));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.parse).toMatchObject({ status: "parsed", source: "ai" });
    const [ip, auth, payload] = state.executeAiCore.mock.calls[0];
    expect(ip).toBe("203.0.113.9");
    expect(auth).toBe("Bearer good");
    expect(payload).toMatchObject({ operation: "resume_extraction" });
    expect(state.admin.tables.onboarding_resume_profiles.get(USER_ID).profile.skills).toContain("Storybook");
  });

  it("scanned PDF: upload still succeeds (200), failure saved with reason, AI never called", async () => {
    const res = await POST(uploadRequest(fixture("scanned.pdf"), "scan.pdf", RESUME_MIME.pdf));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.parse).toEqual({ status: "failed", reason: "scanned_pdf" });
    expect(state.admin.tables.onboarding_resume_profiles.get(USER_ID)).toMatchObject({ parse_status: "failed", failure_reason: "scanned_pdf" });
    expect(state.executeAiCore).not.toHaveBeenCalled();
  });

  it("empty-text PDF: 200 with parse failed/no_text", async () => {
    const res = await POST(uploadRequest(new TextEncoder().encode("%PDF-1.7\n%%EOF"), "empty.pdf", RESUME_MIME.pdf));
    expect(res.status).toBe(200);
    expect((await res.json()).parse).toEqual({ status: "failed", reason: "no_text" });
  });

  it("profile save fails (e.g. migration not applied yet): upload still 200, parse 'unavailable'", async () => {
    state.admin = makeAdmin({ profileUpsertError: { code: "42P01", message: 'relation "onboarding_resume_profiles" does not exist' } });
    const res = await POST(uploadRequest(fixture("resume.docx"), "cv.docx", RESUME_MIME.docx));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.parse).toEqual({ status: "unavailable" });
    expect(state.admin.tables.onboarding_resume_uploads.get(USER_ID)).toBeTruthy();
  });

  it("AI throwing never breaks the upload", async () => {
    state.executeAiCore = vi.fn(async () => {
      throw new Error("provider down");
    });
    const res = await POST(uploadRequest(fixture("resume.docx"), "cv.docx", RESUME_MIME.docx));
    expect(res.status).toBe(200);
    expect((await res.json()).parse).toMatchObject({ status: "parsed", source: "rules" });
  });

  it("flag off: 503 before any parse or write (Step 2 kill switch unchanged)", async () => {
    process.env[FLAG] = "false";
    const res = await POST(uploadRequest(fixture("resume.docx"), "cv.docx", RESUME_MIME.docx));
    expect(res.status).toBe(503);
    expect(state.admin.tables.onboarding_resume_profiles.size).toBe(0);
    expect(state.executeAiCore).not.toHaveBeenCalled();
  });

  it("bad token: 401 and nothing parsed", async () => {
    const res = await POST(uploadRequest(fixture("resume.docx"), "cv.docx", RESUME_MIME.docx, "bad"));
    expect(res.status).toBe(401);
    expect(state.admin.tables.onboarding_resume_profiles.size).toBe(0);
  });
});
