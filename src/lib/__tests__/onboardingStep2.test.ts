import { describe, it, expect } from "vitest";
import { validateAndNormalizeLinkedInUrl } from "../onboarding/step2";
import {
  BodyTooLargeError,
  MAX_RESUME_SIZE_BYTES,
  RESUME_MIME,
  buildResumeStoragePath,
  readBodyWithLimit,
  sanitizeResumeFileName,
  sniffResumeKind,
  validateResumeFile,
} from "../onboarding/step2Resume";
import { bodyCapForPath, exceedsGlobalBodyCap, GLOBAL_API_BODY_CAP_BYTES } from "../security/bodySize";

const enc = (s: string) => new TextEncoder().encode(s);
export const PDF_BYTES = enc("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
export const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...Array.from(enc("....word/document.xml...."))]);

describe("validateAndNormalizeLinkedInUrl", () => {
  it.each([
    ["https://www.linkedin.com/in/jane-doe", "https://www.linkedin.com/in/jane-doe"],
    ["https://linkedin.com/in/jane-doe/", "https://www.linkedin.com/in/jane-doe"],
    ["linkedin.com/in/jane-doe-123", "https://www.linkedin.com/in/jane-doe-123"],
    ["  https://www.linkedin.com/in/JaneDoe?utm_source=x#top ", "https://www.linkedin.com/in/JaneDoe"],
  ])("accepts %s", (input, expected) => {
    const r = validateAndNormalizeLinkedInUrl(input);
    expect(r.valid).toBe(true);
    expect(r.normalizedUrl).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["http://www.linkedin.com/in/jane", "http scheme"],
    ["javascript:alert(1)", "non-https scheme"],
    ["ftp://linkedin.com/in/jane", "ftp scheme"],
    ["https://in.linkedin.com/in/jane", "country subdomain"],
    ["https://linkedin.com.evil.com/in/jane", "lookalike host"],
    ["https://evil.com/linkedin.com/in/jane", "other host"],
    ["https://user:pw@www.linkedin.com/in/jane", "userinfo"],
    ["https://www.linkedin.com:8443/in/jane", "port"],
    ["https://www.linkedin.com/company/acme", "company page"],
    ["https://www.linkedin.com/in/jane/details/skills", "extra path segment"],
    ["https://www.linkedin.com/in/", "missing handle"],
    ["https://www.linkedin.com/in/ab", "handle too short"],
    ["https://www.linkedin.com/in/jane%20doe", "encoded space"],
    ["https://www.linkedin.com/in/<script>", "markup"],
    [`https://www.linkedin.com/in/${"a".repeat(300)}`, "too long"],
  ])("rejects %s (%s)", (input) => {
    const r = validateAndNormalizeLinkedInUrl(input);
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("rejects non-string input", () => {
    expect(validateAndNormalizeLinkedInUrl(42).valid).toBe(false);
    expect(validateAndNormalizeLinkedInUrl(undefined).valid).toBe(false);
  });
});

describe("resume file validation (MIME + extension + magic bytes)", () => {
  it("sniffs PDF and DOCX by magic bytes", () => {
    expect(sniffResumeKind(PDF_BYTES)).toBe("pdf");
    expect(sniffResumeKind(DOCX_BYTES)).toBe("docx");
    expect(sniffResumeKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toBeNull(); // plain zip
    expect(sniffResumeKind(enc("hello"))).toBeNull();
  });

  it("accepts a real PDF and a real DOCX", () => {
    expect(validateResumeFile(PDF_BYTES, RESUME_MIME.pdf, "cv.pdf")).toEqual({ ok: true, kind: "pdf" });
    expect(validateResumeFile(DOCX_BYTES, RESUME_MIME.docx, "cv.docx")).toEqual({ ok: true, kind: "docx" });
  });

  it("rejects a renamed file whose bytes don't match", () => {
    expect(validateResumeFile(enc("MZ\x90\x00 exe"), RESUME_MIME.pdf, "cv.pdf").ok).toBe(false);
    expect(validateResumeFile(PDF_BYTES, RESUME_MIME.docx, "cv.docx").ok).toBe(false);
  });

  it("rejects a MIME/extension mismatch, other types, empty and oversized files", () => {
    expect(validateResumeFile(PDF_BYTES, "text/plain", "cv.pdf").ok).toBe(false);
    expect(validateResumeFile(PDF_BYTES, RESUME_MIME.pdf, "cv.txt").ok).toBe(false);
    expect(validateResumeFile(PDF_BYTES, "application/msword", "cv.doc").ok).toBe(false);
    expect(validateResumeFile(new Uint8Array(0), RESUME_MIME.pdf, "cv.pdf").ok).toBe(false);
    const big = new Uint8Array(MAX_RESUME_SIZE_BYTES + 1);
    big.set(PDF_BYTES);
    expect(validateResumeFile(big, RESUME_MIME.pdf, "cv.pdf").error).toMatch(/5 MB/);
  });

  it("sanitizes display names and never uses them in the storage path", () => {
    expect(sanitizeResumeFileName("../../etc/pass wd<>.pdf")).toBe("pass wd__.pdf");
    const p = buildResumeStoragePath("11111111-2222-3333-4444-555555555555", "pdf");
    expect(p).toMatch(/^11111111-2222-3333-4444-555555555555\/onboarding\/[0-9a-f-]{36}\.pdf$/);
  });
});

describe("readBodyWithLimit (size cap before buffering)", () => {
  it("rejects early on an oversized Content-Length without reading the body", async () => {
    let pulled = false;
    const body = new ReadableStream(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 }
    );
    const req = new Request("http://x/api", {
      method: "POST",
      body,
      headers: { "content-length": "999999999" },
      // @ts-expect-error undici requires duplex for stream bodies
      duplex: "half",
    });
    await expect(readBodyWithLimit(req, 1000)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulled).toBe(false);
  });

  it("stops a chunked body as soon as it passes the cap", async () => {
    let chunksServed = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        chunksServed++;
        c.enqueue(new Uint8Array(400));
        if (chunksServed > 100) c.close();
      },
    });
    // @ts-expect-error undici requires duplex for stream bodies
    const req = new Request("http://x/api", { method: "POST", body, duplex: "half" });
    await expect(readBodyWithLimit(req, 1000)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(chunksServed).toBeLessThan(10);
  });

  it("returns the bytes when under the cap", async () => {
    const req = new Request("http://x/api", { method: "POST", body: "hello" });
    expect(new TextDecoder().decode(await readBodyWithLimit(req, 1000))).toBe("hello");
  });
});

describe("global body cap override for the resume route only", () => {
  it("lets a 4 MB upload reach /api/onboarding/resume but not other routes", () => {
    const fourMb = String(4 * 1024 * 1024);
    expect(exceedsGlobalBodyCap("POST", "/api/onboarding/resume", fourMb)).toBe(false);
    expect(exceedsGlobalBodyCap("POST", "/api/onboarding/linkedin", fourMb)).toBe(true);
    expect(exceedsGlobalBodyCap("POST", "/api/onboarding/resume/x", fourMb)).toBe(true);
    expect(exceedsGlobalBodyCap("POST", "/api/onboarding/resume", String(6 * 1024 * 1024))).toBe(true);
    expect(bodyCapForPath("/api/track")).toBe(GLOBAL_API_BODY_CAP_BYTES);
  });
});

describe("onboarding step 2 feature flag (strict_true, no client overrides)", () => {
  const FLAG = "NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED";
  const original = process.env[FLAG];
  const restore = () => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  };

  it("client check is on only for exactly 'true'", async () => {
    const { isOnboardingStep2EnabledClient } = await import("@/config/onboarding");
    try {
      for (const [v, expected] of [["true", true], ["false", false], ["TRUE", false], ["1", false], ["", false]] as const) {
        process.env[FLAG] = v;
        expect(isOnboardingStep2EnabledClient()).toBe(expected);
      }
      delete process.env[FLAG];
      expect(isOnboardingStep2EnabledClient()).toBe(false);
    } finally {
      restore();
    }
  });

  it("server check prefers the Cloudflare env binding over process.env", async () => {
    const { isOnboardingStep2EnabledServer } = await import("@/config/onboarding");
    try {
      process.env[FLAG] = "true";
      expect(isOnboardingStep2EnabledServer({ [FLAG]: "false" })).toBe(false);
      expect(isOnboardingStep2EnabledServer({})).toBe(true);
      expect(isOnboardingStep2EnabledServer(undefined)).toBe(true);
      process.env[FLAG] = "false";
      expect(isOnboardingStep2EnabledServer({ [FLAG]: "true" })).toBe(true);
      expect(isOnboardingStep2EnabledServer({ [FLAG]: 1 as unknown as string })).toBe(false);
    } finally {
      restore();
    }
  });

  it("config has no query-string or localStorage override path", async () => {
    const fs = await import("fs");
    const src = fs
      .readFileSync("src/config/onboarding.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/localStorage|URLSearchParams|window\.location|step2_enabled/);
  });
});
