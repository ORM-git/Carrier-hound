import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Guard for Backend sheet rank 28 (Request Tracing) log correlation: every
// route that adopted the structured logger must derive its handler logger
// with the middleware-assigned x-request-id, so app log lines carry the same
// request id as the Sentry request_id tag and the x-request-id response
// header. A route that drops the child binding fails CI.

const ROOT = join(__dirname, "..", "..", "..");

const ROUTES: Array<[string, string, number]> = [
  ["src/app/api/jobs/search/route.ts", "/api/jobs/search", 1],
  ["src/app/api/jobs/top10/route.ts", "/api/jobs/top10", 1],
  ["src/app/api/jobs/pro/route.ts", "/api/jobs/pro", 2],
  ["src/app/api/jobs/suggest/route.ts", "/api/jobs/suggest", 1],
  ["src/app/api/early-access/route.ts", "/api/early-access", 1],
  ["src/app/api/track/route.ts", "/api/track", 1],
  ["src/app/api/me/quota/route.ts", "/api/me/quota", 1],
  ["src/app/api/radar/route.ts", "/api/radar", 1],
  ["src/app/api/stats/route.ts", "/api/stats", 1],
];

// req is optional-chained: route handlers run with a real request in
// production, but offline guard suites call GET() bare to exercise env-var
// failure paths (scripts/test-env-guards.ts); the child binding must not
// throw before the route own missing-env handling runs.
const CHILD_RE = /\.child\(\{ requestId: req\?\.headers\.get\("x-request-id"\)/g;

describe("request-id log correlation guard (Backend sheet rank 28)", () => {
  it("every adopting route binds a base logger and derives per-request children", () => {
    ROUTES.forEach(([file, route, handlers]) => {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(
        src.includes(`const baseLog = createLogger({ context: { route: "${route}" } });`),
        `${file} must bind baseLog with route context "${route}"`,
      ).toBe(true);
      const children = (src.match(CHILD_RE) || []).length;
      expect(
        children,
        `${file} must derive a request-id child logger in ${handlers} handler(s) (found ${children})`,
      ).toBe(handlers);
    });
  });

  it("handler log calls go through the request-scoped child, not a module-level plain logger", () => {
    ROUTES.forEach(([file]) => {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(
        /const log = createLogger\(/.test(src),
        `${file} must not keep a module-level plain logger (use baseLog + per-request child)`,
      ).toBe(false);
    });
  });
});
