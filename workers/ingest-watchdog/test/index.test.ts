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

  describe("validateConfig", () => {
    it("accepts valid environment config", () => {
      const cfg = validateConfig(baseEnv);
      expect(cfg.owner).toBe("ORM-git");
      expect(cfg.repo).toBe("Carrier-hound");
      expect(cfg.cadenceMinutes).toBe(240);
      expect(cfg.graceMinutes).toBe(45);
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

    it("fails on invalid, NaN, or negative timing values", () => {
      expect(() => validateConfig({ ...baseEnv, CADENCE_MINUTES: "NaN" })).toThrow("Invalid timing value for CADENCE_MINUTES");
      expect(() => validateConfig({ ...baseEnv, CADENCE_MINUTES: "-10" })).toThrow("Invalid timing value for CADENCE_MINUTES");
      expect(() => validateConfig({ ...baseEnv, OVERDUE_GRACE_MINUTES: "-5" })).toThrow("Invalid timing value for OVERDUE_GRACE_MINUTES");
      expect(() => validateConfig({ ...baseEnv, STALE_JOB_THRESHOLD_MINUTES: "0" })).toThrow("Invalid timing value for STALE_JOB_THRESHOLD_MINUTES");
      expect(() => validateConfig({ ...baseEnv, ATTEMPT_COOLDOWN_MINUTES: "-1" })).toThrow("Invalid timing value for ATTEMPT_COOLDOWN_MINUTES");
    });
  });

  describe("sendAlert & Webhook Delivery", () => {
    it("successfully sends alert payload", async () => {
      const sentPayloads: any[] = [];
      const mockFetch = vi.fn(async (url: any, init: any) => {
        sentPayloads.push(JSON.parse(init.body));
        return new Response("ok", { status: 200 });
      });

      await sendAlert(baseEnv, { type: "config_error", message: "Test alert" }, mockFetch as any);
      expect(sentPayloads.length).toBe(1);
      expect(sentPayloads[0].alertType).toBe("config_error");
      expect(sentPayloads[0].message).toBe("Test alert");
    });

    it("surfaces webhook delivery failure (HTTP 500)", async () => {
      const mockFetch = vi.fn(async () => new Response("Internal Server Error", { status: 500 }));
      await expect(
        sendAlert(baseEnv, { type: "config_error", message: "Boom" }, mockFetch as any)
      ).rejects.toThrow("Webhook alert failed with HTTP 500");
    });

    it("deduplicates repeated identical alerts within cooldown window", async () => {
      let callCount = 0;
      const mockFetch = vi.fn(async () => {
        callCount++;
        return new Response("ok", { status: 200 });
      });

      const now = 1700000000000;
      await sendAlert(baseEnv, { type: "cohort_failed", message: "Workday failed" }, mockFetch as any, now);
      // Immediate repeat with same type and message
      await sendAlert(baseEnv, { type: "cohort_failed", message: "Workday failed" }, mockFetch as any, now + 1000);

      expect(callCount).toBe(1); // deduplicated!
    });
  });

  describe("fetchWithRetry", () => {
    it("retries on 429 and honors Retry-After header", async () => {
      let attempts = 0;
      const mockFetch = vi.fn(async () => {
        attempts++;
        if (attempts === 1) {
          return new Response("rate limited", {
            status: 429,
            headers: { "Retry-After": "1" },
          });
        }
        return new Response("ok", { status: 200 });
      });

      const res = await fetchWithRetry("https://example.com", {}, mockFetch as any, 2, 5000);
      expect(res.status).toBe(200);
      expect(attempts).toBe(2);
    });

    it("exhausts retries and returns final response or throws", async () => {
      let attempts = 0;
      const mockFetch = vi.fn(async () => {
        attempts++;
        return new Response("service unavailable", { status: 503 });
      });

      const res = await fetchWithRetry("https://example.com", {}, mockFetch as any, 1, 5000);
      expect(res.status).toBe(503);
      expect(attempts).toBe(2);
    });
  });

  describe("inspectIngestionStatus (Read-Only)", () => {
    it("never calls dispatches endpoint", async () => {
      const now = new Date("2026-11-24T06:00:00Z").getTime();
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes("/runs?")) {
          return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });

      const report = await inspectIngestionStatus(baseEnv, mockFetch as any, now);
      expect(report.healthy).toBe(false);
      expect(report.actionRecommended).toBe("dispatch");
      expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining("/dispatches"), expect.anything());
    });

    it("handles jobs fetch failure explicitly", async () => {
      const now = new Date("2026-11-24T05:00:00Z").getTime();
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes("/runs?")) {
          return new Response(
            JSON.stringify({
              workflow_runs: [
                { id: 101, head_branch: "main", status: "completed", conclusion: "success" },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("/runs/101/jobs")) {
          return new Response("API rate limit exceeded", { status: 403 });
        }
        return new Response("not found", { status: 404 });
      });

      await expect(inspectIngestionStatus(baseEnv, mockFetch as any, now)).rejects.toThrow(
        "Failed to fetch jobs for run #101: HTTP 403"
      );
    });

    it("excludes other-branch success and fresh dry-run success from production freshness", async () => {
      const now = new Date("2026-11-24T06:00:00Z").getTime();
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes("/runs?")) {
          return new Response(
            JSON.stringify({
              workflow_runs: [
                // 1. Feature branch run (should be ignored)
                {
                  id: 901,
                  head_branch: "feat/my-branch",
                  status: "completed",
                  conclusion: "success",
                  updated_at: "2026-11-24T05:50:00Z",
                },
                // 2. Main dry-run (should not count as production write)
                {
                  id: 902,
                  head_branch: "main",
                  status: "completed",
                  conclusion: "success",
                  updated_at: "2026-11-24T05:40:00Z",
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("/runs/902/jobs")) {
          return new Response(
            JSON.stringify({
              jobs: [
                { name: "Python ingestion [non-workday] (dry-run)", conclusion: "success" },
                { name: "Python ingestion [workday] (dry-run)", conclusion: "success" },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      });

      const report = await inspectIngestionStatus(baseEnv, mockFetch as any, now);
      // Dry-runs and other branches must not refresh production success
      expect(report.cohorts["non-workday"].status).toBe("never_succeeded");
      expect(report.cohorts["workday"].status).toBe("never_succeeded");
      expect(report.staleCohorts).toEqual(["non-workday", "workday"]);
    });

    it("tracks both cohorts independently: one healthy cohort cannot conceal the other", async () => {
      const now = new Date("2026-11-24T06:00:00Z").getTime();
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes("/runs?")) {
          return new Response(
            JSON.stringify({
              workflow_runs: [
                // Run 1: non-workday succeeded 10m ago, workday failed
                {
                  id: 801,
                  head_branch: "main",
                  status: "completed",
                  conclusion: "failure",
                  updated_at: "2026-11-24T05:50:00Z", // 10m ago
                },
                // Run 2: workday last succeeded 350m ago
                {
                  id: 800,
                  head_branch: "main",
                  status: "completed",
                  conclusion: "success",
                  updated_at: "2026-11-24T00:10:00Z", // 350m ago
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("/runs/801/jobs")) {
          return new Response(
            JSON.stringify({
              jobs: [
                { name: "Python ingestion [non-workday] (write-production-expire)", conclusion: "success" },
                { name: "Python ingestion [workday] (write-production-expire)", conclusion: "failure" },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("/runs/800/jobs")) {
          return new Response(
            JSON.stringify({
              jobs: [
                { name: "Python ingestion [non-workday] (write-production-expire)", conclusion: "success" },
                { name: "Python ingestion [workday] (write-production-expire)", conclusion: "success" },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      });

      const report = await inspectIngestionStatus(baseEnv, mockFetch as any, now);
      expect(report.cohorts["non-workday"].lastSuccessMinutesAgo).toBe(10);
      expect(report.cohorts["non-workday"].status).toBe("healthy");

      // Workday is stale (> 285m) and had a recent failed attempt (10m ago)
      expect(report.cohorts["workday"].lastSuccessMinutesAgo).toBe(350);
      expect(report.staleCohorts).toEqual(["workday"]);
      expect(report.failedCohorts).toEqual(["workday"]);
      // Because workday attempt was 10m ago (< 45m attempt cooldown), cooldown is active
      expect(report.attemptCooldownActive).toBe(true);
      expect(report.actionRecommended).toBe("cooldown_wait");
    });
  });

  describe("checkAndReconcileIngestion", () => {
    it("reports stale active jobs (>= 120m) without dispatching duplicate", async () => {
      const now = new Date("2026-11-24T05:00:00Z").getTime();
      const alerts: any[] = [];
      const mockFetch = vi.fn(async (url: string, init?: any) => {
        if (url.includes("/runs?")) {
          return new Response(
            JSON.stringify({
              workflow_runs: [
                {
                  id: 7001,
                  head_branch: "main",
                  status: "queued",
                  created_at: "2026-11-24T02:30:00Z", // 150m ago
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("alerts.example.com")) {
          alerts.push(JSON.parse(init.body));
          return new Response("ok", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });

      const res = await checkAndReconcileIngestion(baseEnv, mockFetch as any, now);
      expect(res.action).toBe("stale_job_reported");
      expect(res.durationMinutes).toBe(150);
      expect(alerts.length).toBe(1);
      expect(alerts[0].alertType).toBe("stale_job");
      expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining("/dispatches"), expect.anything());
    });

    it("respects attempt cooldown: stale success + recent attempt skips dispatch", async () => {
      const now = new Date("2026-11-24T06:00:00Z").getTime();
      const mockFetch = vi.fn(async (url: string, init?: any) => {
        if (url.includes("/runs?")) {
          return new Response(
            JSON.stringify({
              workflow_runs: [
                // Recent attempt 15m ago that failed
                {
                  id: 6001,
                  head_branch: "main",
                  status: "completed",
                  conclusion: "failure",
                  updated_at: "2026-11-24T05:45:00Z", // 15m ago
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("/runs/6001/jobs")) {
          return new Response(
            JSON.stringify({
              jobs: [
                { name: "Python ingestion [non-workday] (write-production-expire)", conclusion: "failure" },
                { name: "Python ingestion [workday] (write-production-expire)", conclusion: "failure" },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("alerts.example.com")) {
          return new Response("ok", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });

      const res = await checkAndReconcileIngestion(baseEnv, mockFetch as any, now);
      expect(res.action).toBe("cooldown_wait");
      expect(res.reason).toContain("attempt cooldown is active");
      // Must not dispatch
      expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining("/dispatches"), expect.anything());
    });

    it("dispatches only degraded cohort when single cohort is stale (never rewrites healthy cohort)", async () => {
      const now = new Date("2026-11-24T06:00:00Z").getTime();
      let dispatchPayload: any = null;

      const mockFetch = vi.fn(async (url: string, init?: any) => {
        if (url.includes("/runs?")) {
          return new Response(
            JSON.stringify({
              workflow_runs: [
                // Run 1: non-workday succeeded 10m ago
                {
                  id: 5001,
                  head_branch: "main",
                  status: "completed",
                  conclusion: "success",
                  updated_at: "2026-11-24T05:50:00Z", // 10m ago
                },
                // Run 2: workday last attempt/success was 300m ago (outside 45m attempt cooldown)
                {
                  id: 5000,
                  head_branch: "main",
                  status: "completed",
                  conclusion: "success",
                  updated_at: "2026-11-24T01:00:00Z", // 300m ago
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("/runs/5001/jobs")) {
          return new Response(
            JSON.stringify({
              jobs: [
                { name: "Python ingestion [non-workday] (write-production-expire)", conclusion: "success" },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("/runs/5000/jobs")) {
          return new Response(
            JSON.stringify({
              jobs: [
                { name: "Python ingestion [workday] (write-production-expire)", conclusion: "success" },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("/dispatches")) {
          dispatchPayload = JSON.parse(init.body);
          return new Response(null, { status: 204 });
        }
        return new Response("not found", { status: 404 });
      });

      const res = await checkAndReconcileIngestion(baseEnv, mockFetch as any, now);
      expect(res.action).toBe("dispatched");
      expect(res.targetCohort).toBe("workday");
      expect(dispatchPayload.inputs.cohort).toBe("workday");
    });
  });

  describe("HTTP Routing & Security Guarantees", () => {
    it("GET /health reports 200 when configured and 503 when unconfigured", async () => {
      // 1. Configured
      const healthyReq = new Request("https://worker.test/health", { method: "GET" });
      const healthyRes = await worker.fetch(healthyReq, baseEnv, {});
      expect(healthyRes.status).toBe(200);
      const healthyBody = await healthyRes.json();
      expect(healthyBody.status).toBe("healthy");
      expect(healthyBody.ready).toBe(true);

      // 2. Unconfigured (missing token)
      const unhealthyReq = new Request("https://worker.test/health", { method: "GET" });
      const unhealthyRes = await worker.fetch(unhealthyReq, { ...baseEnv, GITHUB_TOKEN: "" }, {});
      expect(unhealthyRes.status).toBe(503);
      const unhealthyBody = await unhealthyRes.json();
      expect(unhealthyBody.status).toBe("unhealthy");
      expect(unhealthyBody.ready).toBe(false);
      expect(unhealthyBody.issue).toContain("Missing GITHUB_TOKEN");
    });

    it("GET /check is genuinely read-only inspection and cannot dispatch", async () => {
      // Mock fetch with overdue status
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes("/runs?")) {
          return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", mockFetch);

      const req = new Request("https://worker.test/check", { method: "GET" });
      const res = await worker.fetch(req, baseEnv, {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.readOnly).toBe(true);
      expect(body.inspection.actionRecommended).toBe("dispatch");

      // Verify NO dispatch occurred
      expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining("/dispatches"), expect.anything());
    });

    it("rejects non-GET on /check with 405 Method Not Allowed", async () => {
      const req = new Request("https://worker.test/check", { method: "POST" });
      const res = await worker.fetch(req, baseEnv, {});
      expect(res.status).toBe(405);
    });

    it("POST /dispatch denies anonymous and wrong auth requests", async () => {
      // 1. Anonymous POST
      const anonReq = new Request("https://worker.test/dispatch", { method: "POST" });
      const anonRes = await worker.fetch(anonReq, baseEnv, {});
      expect(anonRes.status).toBe(401);

      // 2. Wrong auth POST
      const wrongAuthReq = new Request("https://worker.test/dispatch", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token" },
      });
      const wrongAuthRes = await worker.fetch(wrongAuthReq, baseEnv, {});
      expect(wrongAuthRes.status).toBe(401);
    });

    it("never exposes GITHUB_TOKEN in error or inspection responses", async () => {
      const req = new Request("https://worker.test/dispatch", { method: "POST" });
      const res = await worker.fetch(req, baseEnv, {});
      const text = await res.text();
      expect(text).not.toContain("ghp_fake_token_for_testing_123");
    });
  });
});
