import { describe, it, expect, vi } from "vitest";
import { validateResumeUploadFile, MAX_RESUME_UPLOAD_BYTES } from "@/lib/resume/parser";
import { uploadResumeFile } from "@/lib/resume/storage";

// Backend sheet rank 70: file upload validation must hold server-side too,
// not only in client components. uploadResumeFile is the single storage
// entry point; these tests pin its enforcement with a mocked Supabase client.

function fakeClient(uploadSpy: ReturnType<typeof vi.fn>) {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
    },
    storage: {
      from: () => ({
        upload: uploadSpy,
        createSignedUrl: async () => ({ data: { signedUrl: "https://example.invalid/signed" }, error: null }),
      }),
    },
  };
}

describe("validateResumeUploadFile (client validator)", () => {
  it("accepts an in-limit pdf", () => {
    const r = validateResumeUploadFile({ name: "cv.pdf", size: 1024 });
    expect(r.valid).toBe(true);
    expect(r.extension).toBe("pdf");
  });

  it("rejects unsupported extensions", () => {
    expect(validateResumeUploadFile({ name: "evil.exe", size: 1024 }).valid).toBe(false);
    expect(validateResumeUploadFile({ name: "noext", size: 1024 }).valid).toBe(false);
  });

  it("rejects empty and oversized files", () => {
    expect(validateResumeUploadFile({ name: "a.pdf", size: 0 }).valid).toBe(false);
    expect(validateResumeUploadFile({ name: "a.pdf", size: MAX_RESUME_UPLOAD_BYTES + 1 }).valid).toBe(false);
    expect(validateResumeUploadFile({ name: "a.pdf", size: MAX_RESUME_UPLOAD_BYTES }).valid).toBe(true);
  });
});

describe("uploadResumeFile (server-side enforcement)", () => {
  it("rejects a disallowed extension before touching storage", async () => {
    const uploadSpy = vi.fn(async () => ({ error: null }));
    await expect(
      uploadResumeFile(new Uint8Array([1, 2, 3]), "payload.exe", fakeClient(uploadSpy) as any),
    ).rejects.toThrow("Unsupported file format");
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it("rejects an oversized file before touching storage", async () => {
    const uploadSpy = vi.fn(async () => ({ error: null }));
    const big = { size: MAX_RESUME_UPLOAD_BYTES + 1 } as File;
    await expect(uploadResumeFile(big, "big.pdf", fakeClient(uploadSpy) as any)).rejects.toThrow(
      "File size exceeds 10MB limit",
    );
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it("rejects an extensionless name even when size is unknown", async () => {
    const uploadSpy = vi.fn(async () => ({ error: null }));
    await expect(
      uploadResumeFile(new Uint8Array([1, 2, 3]), "noextension", fakeClient(uploadSpy) as any),
    ).rejects.toThrow("Unsupported file format");
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it("accepts a valid upload and returns an owner-scoped path", async () => {
    const uploadSpy = vi.fn(async () => ({ error: null }));
    const res = await uploadResumeFile(new Uint8Array([1, 2, 3]), "cv.pdf", fakeClient(uploadSpy) as any);
    expect(uploadSpy).toHaveBeenCalledOnce();
    expect(res.path.startsWith("user-1/")).toBe(true);
    expect(res.signedUrl).toContain("https://");
  });
});
