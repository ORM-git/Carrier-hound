import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import path from "path";
import {
  scanSecrets,
  scanHeaders,
  scanAuthGating,
  scanDebugSurfaces,
  scanPaymentsOff,
  createReporter,
} from "../../../scripts/check-prelaunch-security.cjs";

const ROOT = path.resolve(__dirname, "../../..");

describe("Pre-Launch Security Checker Negative Controls", () => {
  it("NC1: Secret detection triggers non-zero failure on modern secret keys (sb_secret_*)", () => {
    const reporter = createReporter();
    const mockFiles = ["src/fake-service.ts"];
    const mockContent = 'const key = "' + "sb_" + "secret_" + '1234567890abcdef";';

    scanSecrets({
      files: mockFiles,
      readFile: () => mockContent,
      reporter,
    });

    expect(reporter.failed).toBeGreaterThan(0);
    expect(reporter.failures[0].reason).toContain("secret(s) found outside reviewed exemptions");
  });

  it("NC2: Headers parity triggers non-zero failure on CSP mismatch and unauthorized script-src", () => {
    const reporter = createReporter();
    const badHeaders = `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
  Content-Security-Policy: default-src 'self'; script-src 'self' https://unauthorized.tracker.com;
`;
    const goodNetlify = `[[headers]]
  for = "/*"
  [headers.values]
    X-Content-Type-Options = "nosniff"
    X-Frame-Options = "DENY"
    Referrer-Policy = "strict-origin-when-cross-origin"
    Strict-Transport-Security = "max-age=31536000; includeSubDomains; preload"
    Content-Security-Policy = "default-src 'self';"
`;

    scanHeaders({
      headersRaw: badHeaders,
      netlifyRaw: goodNetlify,
      reporter,
    });

    expect(reporter.failed).toBeGreaterThan(0);
    expect(reporter.failures.some((f) => f.checkName.includes("CSP"))).toBe(true);
  });

  it("NC3a: Auth contract triggers non-zero failure when admin route removes verifyAdminSession() call", () => {
    const reporter = createReporter();
    const mutatedAdminRoute = `import { verifyAdminSession } from "@/lib/admin/auth";
export async function GET(req: Request) {
  // Call removed, but import kept!
  return Response.json({ ok: true });
}`;

    scanAuthGating({
      apiFiles: ["src/app/api/admin/stats/route.ts"],
      readFile: () => mutatedAdminRoute,
      reporter,
    });

    expect(reporter.failed).toBeGreaterThan(0);
    expect(reporter.failures.some((f) => f.checkName.includes("contract"))).toBe(true);
  });

  it("NC3b: Webhook contract triggers non-zero failure when HMAC verification is missing", () => {
    const reporter = createReporter();
    const insecureWebhook = `export function createHandler() {
  return async function handler(event: any) {
    // Missing crypto.createHmac and timingSafeEqual
    return { statusCode: 200, body: "ok" };
  };
}`;

    scanAuthGating({
      apiFiles: ["netlify/functions/billing-razorpay-webhook.ts"],
      readFile: () => insecureWebhook,
      reporter,
    });

    expect(reporter.failed).toBeGreaterThan(0);
    expect(reporter.failures.some((f) => f.evidence?.includes("missing HMAC"))).toBe(true);
  });

  it("NC4a: Debug surface scanner triggers non-zero failure on exported fixture", () => {
    const reporter = createReporter();
    const pageWithFixture = `export const debugFixture = { user: "test" };
export default function Page() { return null; }`;

    scanDebugSurfaces({
      appFiles: ["src/app/test-view/page.tsx"],
      serverFiles: [],
      readFile: () => pageWithFixture,
      reporter,
    });

    expect(reporter.failed).toBeGreaterThan(0);
    expect(reporter.failures.some((f) => f.checkName.includes("fixture"))).toBe(true);
  });

  it("NC4b: Logging scanner triggers non-zero failure when console.error leaks sensitive token payload", () => {
    const reporter = createReporter();
    const serverCodeWithLeak = `export function authCheck(req: any) {
  const token = "secret-token";
  console.error("Auth failed with token:", token);
}`;

    scanDebugSurfaces({
      appFiles: [],
      serverFiles: ["src/lib/auth/check.ts"],
      readFile: () => serverCodeWithLeak,
      reporter,
    });

    expect(reporter.failed).toBeGreaterThan(0);
    expect(reporter.failures.some((f) => f.checkName.includes("console.(log|error|warn)"))).toBe(true);
  });

  it("NC5a: Billing scanner triggers non-zero failure when NEXT_PUBLIC_BILLING_ENABLED=true in env", () => {
    const reporter = createReporter();
    scanPaymentsOff({
      env: { NEXT_PUBLIC_BILLING_ENABLED: "true" },
      nextContent: 'if (process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true") { return 503; }',
      netlifyContent: 'if (process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true") { return 503; }',
      flagsContent: '{ envVar: "NEXT_PUBLIC_BILLING_ENABLED", rule: "strict_true", defaultEnabled: false }',
      envExampleContent: "NEXT_PUBLIC_BILLING_ENABLED=false",
      reporter,
    });

    expect(reporter.failed).toBeGreaterThan(0);
    expect(reporter.failures.some((f) => f.checkName.includes("Local environment payments-off baseline"))).toBe(true);
  });

  it("NC5b: Billing scanner triggers non-zero failure when order gate is bypassed with if (false && ...)", () => {
    const reporter = createReporter();
    const bypassedOrderRoute = `export async function POST() {
  if (false && process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true") {
    return NextResponse.json({ code: "BILLING_DISABLED" }, { status: 503 });
  }
}`;

    scanPaymentsOff({
      env: { NEXT_PUBLIC_BILLING_ENABLED: "false" },
      nextContent: bypassedOrderRoute,
      netlifyContent: 'if (process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true") { return 503; }',
      flagsContent: '{ envVar: "NEXT_PUBLIC_BILLING_ENABLED", rule: "strict_true", defaultEnabled: false }',
      envExampleContent: "NEXT_PUBLIC_BILLING_ENABLED=false",
      reporter,
    });

    expect(reporter.failed).toBeGreaterThan(0);
    expect(reporter.failures.some((f) => f.checkName.includes("Next.js Razorpay order route"))).toBe(true);
  });

  it("Full CLI runner fails with exit code 1 when NEXT_PUBLIC_BILLING_ENABLED=true", () => {
    let exitCode = 0;
    try {
      execSync("node scripts/check-prelaunch-security.cjs", {
        cwd: ROOT,
        env: { ...process.env, NEXT_PUBLIC_BILLING_ENABLED: "true" },
        stdio: "pipe",
      });
    } catch (err: any) {
      exitCode = err.status;
    }
    expect(exitCode).toBe(1);
  });

  it("Full CLI runner passes all negative controls via --test-negative-controls with exit code 0", () => {
    const output = execSync("node scripts/check-prelaunch-security.cjs --test-negative-controls", {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(output).toContain("NEGATIVE CONTROLS RESULT: 8/8 passed");
  });
});
