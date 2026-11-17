import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({
  admin: null as any,
}));

vi.mock("@/lib/ai/serviceHandler", () => ({
  getSupabaseAdminClient: vi.fn(() => state.admin),
  getClientIpFromRequest: (req: Request) => req.headers.get("cf-connecting-ip") || "anonymous-client",
}));
vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: vi.fn(() => undefined) }));

import { POST as postLinkedIn } from "@/app/api/onboarding/linkedin/route";
import { POST as postResume } from "@/app/api/onboarding/resume/route";
import { RESUME_MIME } from "@/lib/onboarding/step2Resume";

const NO_STORE = "private, no-cache, no-store, must-revalidate";
const USER_ID = "11111111-2222-3333-4444-555555555555";
const enc = (s: string) => new TextEncoder().encode(s);
const PDF = enc("%PDF-1.7\n%%EOF");

function makeAdmin(opts: {
  updateUserError?: any;
  readError?: any;
  previousPath?: string | null;
  uploadError?: any;
  upsertError?: any;
  orphans?: string[];
} = {}) {
  const calls = {
    updateUserById: [] as any[],
    uploads: [] as { path: string; contentType: string; upsert: boolean }[],
    upserts: [] as any[],
    removes: [] as string[][],
    rpc: [] as any[],
  };
  const admin = {
    calls,
    auth: {
      getUser: vi.fn(async (t: string) =>
        t === "good" ? { data: { user: { id: USER_ID } }, error: null } : { data: { user: null }, error: { message: "bad" } }
      ),
      admin: {
        updateUserById: vi.fn(async (id: string, attrs: any) => {
          calls.updateUserById.push({ id, attrs });
          return { data: {}, error: opts.updateUserError ?? null };
        }),
      },
    },
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: opts.previousPath ? { storage_path: opts.previousPath } : null,
            error: opts.readError ?? null,
          }),
        }),
      }),
      upsert: async (row: any) => {
        calls.upserts.push(row);
        return { error: opts.upsertError ?? null };
      },
    })),
    storage: {
      from: vi.fn(() => ({
        upload: async (path: string, _blob: Blob, o: any) => {
          calls.uploads.push({ path, contentType: o.contentType, upsert: o.upsert });
          return { error: opts.uploadError ?? null };
        },
        remove: async (names: string[]) => {
          calls.removes.push(names);
          return { error: null };
        },
      })),
    },
    rpc: vi.fn(async (name: string, args: any) => {
      calls.rpc.push({ name, args });
      return { data: (opts.orphans ?? []).map((object_name) => ({ object_name })), error: null };
    }),
  };
  return admin;
}

let rateAllowed = true;
const rateKeys: string[] = [];

beforeEach(() => {
  rateAllowed = true;
  rateKeys.length = 0;
  (globalThis as any).__mockRateLimitClient = {
    rpc: async (_n: string, args: any) => {
      rateKeys.push(args.p_key);
      return { data: { allowed: rateAllowed, retry_after: rateAllowed ? 0 : 120, current_count: 1 }, error: null };
    },
  };
});
afterEach(() => {
  delete (globalThis as any).__mockRateLimitClient;
});

function linkedInReq(body: unknown, token = "good") {
  return new Request("http://localhost/api/onboarding/linkedin", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "cf-connecting-ip": "1.2.3.4" },
    body: JSON.stringify(body),
  });
}

function resumeReq(file: File | null, token = "good") {
  const form = new FormData();
  if (file) form.append("file", file);
  return new Request("http://localhost/api/onboarding/resume", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "1.2.3.4" },
    body: form,
  });
}

describe("POST /api/onboarding/linkedin", () => {
  it("normalizes and saves to user_metadata only (no scraping), with no-store", async () => {
    state.admin = makeAdmin();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await postLinkedIn(linkedInReq({ linkedinUrl: "linkedin.com/in/jane-doe/" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(await res.json()).toEqual({ ok: true, linkedinUrl: "https://www.linkedin.com/in/jane-doe" });
    expect(state.admin.calls.updateUserById).toEqual([
      { id: USER_ID, attrs: { user_metadata: { linkedin_url: "https://www.linkedin.com/in/jane-doe" } } },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects invalid URLs with 400 and writes nothing", async () => {
    state.admin = makeAdmin();
    const res = await postLinkedIn(linkedInReq({ linkedinUrl: "http://www.linkedin.com/in/jane" }));
    expect(res.status).toBe(400);
    expect(state.admin.calls.updateUserById).toHaveLength(0);
  });

  it("returns 500 when the Supabase update fails", async () => {
    state.admin = makeAdmin({ updateUserError: { message: "boom" } });
    const res = await postLinkedIn(linkedInReq({ linkedinUrl: "https://www.linkedin.com/in/jane-doe" }));
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });

  it("401 without a valid token; 429 with Retry-After when rate limited (per user and per IP keys)", async () => {
    state.admin = makeAdmin();
    expect((await postLinkedIn(linkedInReq({}, "bad"))).status).toBe(401);
    rateAllowed = false;
    const res = await postLinkedIn(linkedInReq({ linkedinUrl: "https://www.linkedin.com/in/jane-doe" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(rateKeys).toEqual(expect.arrayContaining([`onboarding_linkedin:user:${USER_ID}`, "onboarding_linkedin:ip:1.2.3.4"]));
    expect(state.admin.calls.updateUserById).toHaveLength(0);
  });
});

describe("POST /api/onboarding/resume", () => {
  it("stores a PDF privately under <uid>/onboarding/, writes the pointer and retires the old file", async () => {
    state.admin = makeAdmin({ previousPath: `${USER_ID}/onboarding/old.pdf`, orphans: [`${USER_ID}/onboarding/stale.pdf`] });
    const res = await postResume(resumeReq(new File([PDF], "My CV.pdf", { type: RESUME_MIME.pdf })));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, fileName: "My CV.pdf", kind: "pdf", sizeBytes: PDF.byteLength });

    const [upload] = state.admin.calls.uploads;
    expect(upload.path).toMatch(new RegExp(`^${USER_ID}/onboarding/[0-9a-f-]{36}\\.pdf$`));
    expect(upload).toMatchObject({ contentType: RESUME_MIME.pdf, upsert: false });
    expect(state.admin.calls.upserts[0]).toMatchObject({ user_id: USER_ID, storage_path: upload.path, mime_type: RESUME_MIME.pdf });
    expect(state.admin.calls.removes).toContainEqual([`${USER_ID}/onboarding/old.pdf`]);
    expect(state.admin.calls.removes).toContainEqual([`${USER_ID}/onboarding/stale.pdf`]);
    expect(rateKeys).toEqual(expect.arrayContaining([`onboarding_resume:user:${USER_ID}`, "onboarding_resume:ip:1.2.3.4"]));
  });

  it("rejects a file whose magic bytes don't match (no upload)", async () => {
    state.admin = makeAdmin();
    const res = await postResume(resumeReq(new File([enc("not a pdf")], "cv.pdf", { type: RESUME_MIME.pdf })));
    expect(res.status).toBe(400);
    expect(state.admin.calls.uploads).toHaveLength(0);
  });

  it("rejects disallowed MIME types and missing files", async () => {
    state.admin = makeAdmin();
    expect((await postResume(resumeReq(new File([PDF], "cv.txt", { type: "text/plain" })))).status).toBe(400);
    expect((await postResume(resumeReq(null))).status).toBe(400);
    expect(state.admin.calls.uploads).toHaveLength(0);
  });

  it("returns 413 for a body over the cap, before upload", async () => {
    state.admin = makeAdmin();
    const big = new Uint8Array(5 * 1024 * 1024 + 70 * 1024);
    big.set(PDF);
    const res = await postResume(resumeReq(new File([big], "cv.pdf", { type: RESUME_MIME.pdf })));
    expect(res.status).toBe(413);
    expect(state.admin.calls.uploads).toHaveLength(0);
  });

  it("returns 500 and uploads nothing when the pointer read fails", async () => {
    state.admin = makeAdmin({ readError: { message: "db down" } });
    const res = await postResume(resumeReq(new File([PDF], "cv.pdf", { type: RESUME_MIME.pdf })));
    expect(res.status).toBe(500);
    expect(state.admin.calls.uploads).toHaveLength(0);
  });

  it("returns 500 when the storage upload fails and writes no pointer", async () => {
    state.admin = makeAdmin({ uploadError: { message: "storage down" } });
    const res = await postResume(resumeReq(new File([PDF], "cv.pdf", { type: RESUME_MIME.pdf })));
    expect(res.status).toBe(500);
    expect(state.admin.calls.upserts).toHaveLength(0);
  });

  it("removes the just-uploaded object when the pointer upsert fails (no orphan), keeps the old file", async () => {
    state.admin = makeAdmin({ upsertError: { message: "constraint" }, previousPath: `${USER_ID}/onboarding/old.pdf` });
    const res = await postResume(resumeReq(new File([PDF], "cv.pdf", { type: RESUME_MIME.pdf })));
    expect(res.status).toBe(500);
    const newPath = state.admin.calls.uploads[0].path;
    expect(state.admin.calls.removes).toEqual([[newPath]]);
  });

  it("401 without a valid token; 429 when rate limited, before reading the body", async () => {
    state.admin = makeAdmin();
    expect((await postResume(resumeReq(null, "bad"))).status).toBe(401);
    rateAllowed = false;
    const res = await postResume(resumeReq(new File([PDF], "cv.pdf", { type: RESUME_MIME.pdf })));
    expect(res.status).toBe(429);
    expect(state.admin.calls.uploads).toHaveLength(0);
  });
});
