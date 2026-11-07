import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Guard for Backend sheet rank 11 (Structured JSON Logging) adoption in the
// request-path lib modules: every module below routes its log lines through
// the shared structured logger (src/lib/observability/logger) with its
// module path bound as context, and carries zero raw console.* calls.
// Reverting a module to console.* fails CI.
//
// Deliberately excluded:
// - src/lib/observability/logger.ts (the seam itself owns console output),
// - src/lib/cron/dailyDigestCron.ts (covered by the digest batching PR).

const ROOT = join(__dirname, "..", "..", "..");

const ADOPTERS = [
  "src/lib/account/deleteHandler.ts",
  "src/lib/admin/analytics.ts",
  "src/lib/admin/auditLog.ts",
  "src/lib/admin/auth.ts",
  "src/lib/ai/groq.ts",
  "src/lib/ai/security.ts",
  "src/lib/ai/serviceHandler.ts",
  "src/lib/api/envCheck.ts",
  "src/lib/api/routeBudget.ts",
  "src/lib/api/sharedRateLimit.ts",
  "src/lib/auth/session.ts",
  "src/lib/billing/consume.ts",
  "src/lib/billing/dunning.ts",
  "src/lib/billing/dunningDispatcher.ts",
  "src/lib/billing/quota.ts",
  "src/lib/billing/razorpay.ts",
  "src/lib/billing/serverEntitlement.ts",
  "src/lib/billing/subscription.ts",
  "src/lib/cron/digestStorage.ts",
  "src/lib/early-access/gmail.ts",
  "src/lib/events/failedEvents.ts",
  "src/lib/interview-pack/handler.ts",
  "src/lib/jobs/service.ts",
  "src/lib/resume/parser.ts",
  "src/lib/resume/storage.ts",
  "src/lib/security/authMonitor.ts",
  "src/lib/tracker/storage.ts",
];

describe("structured logging adoption guard: lib modules (Backend sheet rank 11)", () => {
  it("every adopting module imports the seam logger and binds its module context", () => {
    ADOPTERS.forEach((file) => {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(
        src.includes('createLogger } from "@/lib/observability/logger"'),
        `${file} must import createLogger from the observability seam`,
      ).toBe(true);
      const moduleName = file.replace("src/lib/", "").replace(/\.ts$/, "");
      // authMonitor binds its logger as `logger` to avoid collision with the
      // injected deps.log alert sink; every other module binds `log`.
      expect(
        src.includes(`createLogger({ context: { module: "${moduleName}" } })`),
        `${file} must bind module context "${moduleName}"`,
      ).toBe(true);
    });
  });

  it("adopting modules carry no raw console.* calls", () => {
    const bad: string[] = [];
    ADOPTERS.forEach((file) => {
      const src = readFileSync(join(ROOT, file), "utf8");
      if (/console\.(log|info|warn|error|debug)\(/.test(src)) bad.push(file);
    });
    expect(
      bad,
      `module(s) reverted to raw console.*: ${bad.join(", ")} - log through the structured logger instead`,
    ).toEqual([]);
  });
});
