/**
 * Unit and contract tests for Cloudflare Ingest Watchdog Worker
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import worker, {
  checkAndReconcileIngestion,
  inspectIngestionStatus,
  validateConfig,
  sendAlert,
  fetchWithRetry,
  parseRetryAfter,
  clearAlertCache,
  Env,
} from "../src/index";

describe("Ingest Watchdog Worker", () => {
  const baseEnv: Env = {
    GITHUB_TOKEN: "ghp_fake_token_for_testing_123",
    REPO_OWNER: "ORM-git",
    REPO_NAME: "Carrier-hound",
    WORKFLOW_FILE: "python-ingest.yml",
    TARGET_BRANCH: "main",
    CADENCE_MINUTES: "240",
    OVERDUE_GRACE_MINUTES: "45",
    STALE_JOB_THRESHOLD_MINUTES: "120",
    ATTEMPT_COOLDOWN_MINUTES: "45",
    ALERT_WEBHOOK_URL: "https://alerts.example.com/webhook",
    DISPATCH_SECRET: "correct-dispatch-secret-456",
  };

  beforeEach(() => {
    clearAlertCache();
    vi.restoreAllMocks();
  });

  describe("validateConfig & Timing Bounds", () => {
    it("accepts valid environment config", () => {
      const cfg = validateConfig(baseEnv);
      expect(cfg.owner).toBe("ORM-git");
      expect(cfg.repo).toBe("Carrier-hound");
      expect(cfg.cadenceMinutes).toBe(240);
      expect(cfg.graceMinutes).toBe(45);
      expect(cfg.overdueThresholdMinutes).toBe(285);
      expect(cfg.staleJobMinutes).toBe(120);
      expect(cfg.attemptCooldownMinutes).toBe(45);
      expect(cfg.alertWebhookUrl).toBe("https://alerts.example.com/webhook");
    });

    it("fails visibly when GITHUB_TOKEN is missing", () => {
      expect(() => validateConfig({ ...baseEnv, GITHUB_TOKEN: "" })).toThrow("Missing GITHUB_TOKEN");
    });

    it("fails visibly when ALERT_WEBHOOK_URL is missing or invalid", () => {
      expect(() => validateConfig({ ...baseEnv, ALERT_WEBHOOK_URL: "" })).toThrow("Missing ALERT_WEBHOOK_URL");
      expect(() => validateConfig({ ...baseEnv, ALERT_WEBHOOK_URL: "not-a-url" })).toThrow("Invalid ALERT_WEBHOOK_URL");
      expect(() => validateConfig({ ...baseEnv, ALERT_WEBHOOK_URL: "ftp://example.com" })).toThrow("Invalid ALERT_WEBHOOK_URL");
    });

    it("fails on invalid, NaN, negative, or excessive timing values", () => {
      expect(() => validateConfig({ ...baseEnv, CADENCE_MINUTES: "NaN" })).toThrow("Invalid timing value for CADENCE_MINUTES");
      expect(() => validateConfig({ ...baseEnv, CADENCE_MINUTES: "-10" })).toThrow("Invalid timing value for CADENCE_MINUTES");
      expect(() => validateConfig({ ...baseEnv, CADENCE_MINUTES: "5" })).toThrow("must be an integer between 15 and 1440");
      expect(() => validateConfig({ ...baseEnv, CADENCE_MINUTES: "2000" })).toThrow("must be an integer between 15 and 1440");
      expect(() => validateConfig({ ...baseEnv, OVERDUE_GRACE_MINUTES: "500" })).toThrow("must be an integer between 0 and 360");
      expect(() => validateConfig({ ...baseEnv, STALE_JOB_THRESHOLD_MINUTES: "10" })).toThrow("must be an integer between 15 and 720");
      expect(() => validateConfig({ ...baseEnv, ATTEMPT_COOLDOWN_MINUTES: "1" })).toThrow("must be an integer between 5 and 360");
    });
  });

  describe("parseRetryAfter & fetchWithRetry", () => {
    it("parses delta-seconds correctly", () => {
      expect(parseRetryAfter("60")).toBe(60);
      expect(parseRetryAfter("0")).toBe(0);
      expect(parseRetryAfter(null)).toBeNull();
      expect(parseRetryAfter("")).toBeNull();
    });

    it("parses HTTP-date correctly", () => {
      const now = new Date("2026-11-24T08:00:00Z").getTime();
      const httpDate = "Tue, 24 Nov 2026 08:01:30 GMT"; // 90 seconds in the future
      expect(parseRetryAfter(httpDate, now)).toBe(90);
    });

    it("honors Retry-After 120s by deferring without retrying early at 5s", async () => {
      let attempts = 0;
      const mockFetch = vi.fn(async () => {
        attempts++;
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "120" },
        });
      });

      // Budget is 30s; 120s exceeds budget, so it must throw/defer immediately without retrying early!
      await expect(
        fetchWithRetry("https://example.com", {}, mockFetch as any, 2, 5000, 30)
      ).rejects.toThrow("exceeding retry budget (30s); deferring execution.");

      expect(attempts).toBe(1); // Never retried at 5s!
    });
  });

  describe("Schema Validation & Pagination in inspectIngestionStatus", () => {
    const now = new Date("2026-11-24T06:00:00Z").getTime();

    it("fails closed on API 200 with empty object {}", async () => {
      const mockFetch = vi.fn(async () => new Response("{}", { status: 200 }));
      await expect(inspectIngestionStatus(baseEnv, mockFetch as any, now)).rejects.toThrow(
        "Invalid runs API response schema: missing or malformed 'workflow_runs'"
      );
    });

    it("fails closed on wrong field types in runs response", async () => {
      const mockFetch = vi.fn(
        async () => new Response(JSON.stringify({ workflow_runs: "not-an-array", total_count: 5 }), { status: 200 })
      );
      await expect(inspectIngestionStatus(baseEnv, mockFetch as any, now)).rejects.toThrow(
        "Invalid runs API response schema: missing or malformed 'workflow_runs' array"
      );
    });

    it("fails closed on nonzero total_count with empty page", async () => {
      const mockFetch = vi.fn(
        async () => new Response(JSON.stringify({ workflow_runs: [], total_count: 3 }), { status: 200 })
      );
      await expect(inspectIngestionStatus(baseEnv, mockFetch as any, now)).rejects.toThrow(
        "Inconsistent runs API response: nonzero total_count (3) with empty page."
      );
    });

    it("fails closed on empty jobs list for completed run", async () => {
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes("/runs?")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              workflow_runs: [
                { id: 991, head_branch: "main", status: "completed", conclusion: "failure" },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("/runs/991/jobs")) {
          return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });

      await expect(inspectIngestionStatus(baseEnv, mockFetch as any, now)).rejects.toThrow(
        "Unverifiable history: completed run #991 has empty jobs list."
      );
    });

    it("fails closed when pagination bound blocks verification without finding main runs", async () => {
      // 3 pages all on feature branches, but total_count is 150
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes("/runs?")) {
          return new Response(
            JSON.stringify({
              total_count: 150,
              workflow_runs: [
                { id: 1, head_branch: "feat/dev", status: "completed", conclusion: "success" },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      });

      await expect(inspectIngestionStatus(baseEnv, mockFetch as any, now)).rejects.toThrow(
        "History verification truncated at pagination bound"
      );
    });

    it("admits verified bootstrap when total_count is genuinely 0", async () => {
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes("/runs?")) {
          return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });

      const report = await inspectIngestionStatus(baseEnv, mockFetch as any, now);
      expect(report.healthy).toBe(false);
      expect(report.actionRecommended).toBe("dispatch");
      expect(report.staleCohorts).toEqual(["non-workday", "workday"]);
    });
  });

  describe("Shared Cadence / Grace & 200m Old Successful Cohort", () => {
    const now = new Date("2026-11-24T06:00:00Z").getTime();

    it("never rewrites a 200-minute-old successful cohort (fresh within 285m threshold)", async () => {
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes("/runs?")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              workflow_runs: [
                {
                  id: 111,
                  head_branch: "main",
                  status: "completed",
                  conclusion: "success",
                  updated_at: "2026-11-24T02:40:00Z", // 200m ago (< 285m)
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("/runs/111/jobs")) {
          return new Response(
            JSON.stringify({
              jobs: [
                { name: "Python ingestion [non-workday] (write-production-expire)", status: "completed", conclusion: "success" },
                { name: "Python ingestion [workday] (write-production-expire)", status: "completed", conclusion: "success" },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      });

      const report = await inspectIngestionStatus(baseEnv, mockFetch as any, now);
      expect(report.healthy).toBe(true);
      expect(report.cohorts["non-workday"].status).toBe("healthy");
      expect(report.cohorts["workday"].status).toBe("healthy");
      expect(report.staleCohorts).toEqual([]);
      expect(report.actionRecommended).toBe("none");
    });

    it("respects exact threshold boundary: 284m is fresh, 286m is overdue", async () => {
      // Test at 286m (overdue)
      const mockFetchOverdue = vi.fn(async (url: string) => {
        if (url.includes("/runs?")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              workflow_runs: [
                {
                  id: 112,
                  head_branch: "main",
                  status: "completed",
                  conclusion: "success",
                  updated_at: "2026-11-24T01:14:00Z", // 286m ago (> 285m)
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("/runs/112/jobs")) {
          return new Response(
            JSON.stringify({
              jobs: [
                { name: "Python ingestion [non-workday] (write-production-expire)", status: "completed", conclusion: "success" },
                { name: "Python ingestion [workday] (write-production-expire)", status: "completed", conclusion: "success" },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      });

      const reportOverdue = await inspectIngestionStatus(baseEnv, mockFetchOverdue as any, now);
      expect(reportOverdue.healthy).toBe(false);
      expect(reportOverdue.staleCohorts).toEqual(["non-workday", "workday"]);
      expect(reportOverdue.actionRecommended).toBe("dispatch");
    });
  });

  describe("Ambiguous Dispatch POST Protection", () => {
    const now = new Date("2026-11-24T06:00:00Z").getTime();

    it("never double-dispatches on ambiguous network timeout and fails closed if unconfirmed", async () => {
      let dispatchPostAttempts = 0;
      const mockFetch = vi.fn(async (url: string, init?: any) => {
        if (url.includes("/runs?")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              workflow_runs: [
                {
                  id: 50,
                  head_branch: "main",
                  status: "completed",
                  conclusion: "success",
                  updated_at: "2026-11-24T00:00:00Z", // 360m ago
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("/runs/50/jobs")) {
          return new Response(
            JSON.stringify({
              jobs: [
                { name: "Python ingestion [non-workday] (write-production-expire)", status: "completed", conclusion: "success" },
                { name: "Python ingestion [workday] (write-production-expire)", status: "completed", conclusion: "success" },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("/dispatches")) {
          dispatchPostAttempts++;
          throw new Error("Connection reset / network timeout");
        }
        if (url.includes("alerts.example.com")) {
          return new Response("ok", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });

      await expect(checkAndReconcileIngestion(baseEnv, mockFetch as any, now)).rejects.toThrow(
        "Ambiguous dispatch POST outcome"
      );

      // Must have sent exactly ONE POST attempt (no blind retry)
      expect(dispatchPostAttempts).toBe(1);
    });
  });

  describe("HTTP /health Endpoint Readiness", () => {
    it("returns 200 OK when fully healthy", async () => {
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes("/runs?")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              workflow_runs: [
                {
                  id: 201,
                  head_branch: "main",
                  status: "completed",
                  conclusion: "success",
                  updated_at: new Date().toISOString(),
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("/runs/201/jobs")) {
          return new Response(
            JSON.stringify({
              jobs: [
                { name: "Python ingestion [non-workday] (write-production-expire)", status: "completed", conclusion: "success" },
                { name: "Python ingestion [workday] (write-production-expire)", status: "completed", conclusion: "success" },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", mockFetch);

      const req = new Request("https://worker.test/health", { method: "GET" });
      const res = await worker.fetch(req, baseEnv, {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("healthy");
      expect(body.ready).toBe(true);
    });

    it("returns 503 Not-Ready when ingestion state is stale", async () => {
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes("/runs?")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              workflow_runs: [
                {
                  id: 202,
                  head_branch: "main",
                  status: "completed",
                  conclusion: "success",
                  updated_at: "2026-11-20T00:00:00Z", // very old
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("/runs/202/jobs")) {
          return new Response(
            JSON.stringify({
              jobs: [
                { name: "Python ingestion [non-workday] (write-production-expire)", status: "completed", conclusion: "success" },
                { name: "Python ingestion [workday] (write-production-expire)", status: "completed", conclusion: "success" },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", mockFetch);

      const req = new Request("https://worker.test/health", { method: "GET" });
      const res = await worker.fetch(req, baseEnv, {});
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe("not_ready");
      expect(body.ready).toBe(false);
    });

    it("returns 503 when GitHub API fails", async () => {
      const mockFetch = vi.fn(async () => new Response("Forbidden", { status: 403 }));
      vi.stubGlobal("fetch", mockFetch);

      const req = new Request("https://worker.test/health", { method: "GET" });
      const res = await worker.fetch(req, baseEnv, {});
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe("unhealthy");
      expect(body.ready).toBe(false);
      expect(body.issue).toContain("Ingestion state unverifiable");
    });

    it("returns 503 on malformed API history", async () => {
      const mockFetch = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", mockFetch);

      const req = new Request("https://worker.test/health", { method: "GET" });
      const res = await worker.fetch(req, baseEnv, {});
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe("unhealthy");
      expect(body.ready).toBe(false);
    });
  });

  describe("HTTP /check & /dispatch Security", () => {
    it("GET /check is read-only and never calls /dispatches", async () => {
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes("/runs?")) {
          return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", mockFetch);

      const req = new Request("https://worker.test/check", { method: "GET" });
      const res = await worker.fetch(req, baseEnv, {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.readOnly).toBe(true);
      expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining("/dispatches"), expect.anything());
    });

    it("POST /dispatch rejects anonymous and wrong auth requests", async () => {
      const anonReq = new Request("https://worker.test/dispatch", { method: "POST" });
      const anonRes = await worker.fetch(anonReq, baseEnv, {});
      expect(anonRes.status).toBe(401);

      const wrongReq = new Request("https://worker.test/dispatch", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-secret" },
      });
      const wrongRes = await worker.fetch(wrongReq, baseEnv, {});
      expect(wrongRes.status).toBe(401);
    });
  });
});
