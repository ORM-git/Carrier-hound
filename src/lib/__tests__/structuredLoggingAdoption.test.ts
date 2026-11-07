import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Guard for Backend sheet rank 11 (Structured JSON Logging) adoption: the
// public/user API routes that adopted the structured logger keep it - they
// must import createLogger from the observability seam, bind their route
// path as context, and carry zero raw console.* calls (every log line goes
// through the JSON logger). Reverting a route to console.* fails CI.

const ROOT = join(__dirname, "..", "..", "..");

const ADOPTERS: Array<[string, string]> = [
  ["src/app/api/jobs/search/route.ts", "/api/jobs/search"],
  ["src/app/api/jobs/top10/route.ts", "/api/jobs/top10"],
  ["src/app/api/jobs/pro/route.ts", "/api/jobs/pro"],
  ["src/app/api/me/quota/route.ts", "/api/me/quota"],
  ["src/app/api/radar/route.ts", "/api/radar"],
  ["src/app/api/early-access/route.ts", "/api/early-access"],
  ["src/app/api/stats/route.ts", "/api/stats"],
  ["src/app/api/track/route.ts", "/api/track"],
  ["src/app/api/jobs/suggest/route.ts", "/api/jobs/suggest"],
];

describe("structured logging adoption guard (Backend sheet rank 11)", () => {
  it("every adopting route imports the seam logger and binds its route context", () => {
    ADOPTERS.forEach(([file, route]) => {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(
        src.includes('createLogger } from "@/lib/observability/logger"'),
        `${file} must import createLogger from the observability seam`,
      ).toBe(true);
      expect(
        src.includes(`createLogger({ context: { route: "${route}" } })`),
        `${file} must bind route context "${route}"`,
      ).toBe(true);
    });
  });

  it("adopting routes carry no raw console.* calls", () => {
    const bad: string[] = [];
    ADOPTERS.forEach(([file]) => {
      const src = readFileSync(join(ROOT, file), "utf8");
      if (/console\.(log|info|warn|error|debug)\(/.test(src)) bad.push(file);
    });
    expect(
      bad,
      `route(s) reverted to raw console.*: ${bad.join(", ")} - log through the structured logger instead`,
    ).toEqual([]);
  });
});
