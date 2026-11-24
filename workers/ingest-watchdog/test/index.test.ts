/**
 * Unit and contract tests for Cloudflare Ingest Watchdog Worker
 */

import { describe, it, expect, vi } from "vitest";
import {
  checkAndReconcileIngestion,
  validateConfig,
  sendAlert,
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
    ALERT_WEBHOOK_URL: "https://alerts.example.com/webhook",
  };

  it("fails visibly when GITHUB_TOKEN is missing (never silently healthy)", async () => {
    const invalidEnv: Env = { ...baseEnv, GITHUB_TOKEN: "" };
    const alerts: any[] = [];
    const mockFetch = vi.fn(async (url: any, init: any) => {
      alerts.push(JSON.parse(init.body));
      return new Response("ok", { status: 200 });
    });

    await expect(
      checkAndReconcileIngestion(invalidEnv, mockFetch as any)
    ).rejects.toThrow("Missing GITHUB_TOKEN");

    expect(alerts.length).toBe(1);
    expect(alerts[0].alertType).toBe("config_error");
    expect(alerts[0].message).toContain("Missing GITHUB_TOKEN");
  });

  it("skips dispatch when a workflow run is actively running (< 120m)", async () => {
    const now = new Date("2026-11-24T05:00:00Z").getTime();
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes("/runs?")) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 45302827007,
                status: "in_progress",
                created_at: "2026-11-24T04:40:00Z", // 20 min ago
                run_started_at: "2026-11-24T04:40:00Z",
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    });

    const res = await checkAndReconcileIngestion(baseEnv, mockFetch as any, now);
    expect(res.action).toBe("none");
    expect(res.reason).toContain("currently in_progress");
    expect(res.runId).toBe(45302827007);
    // Dispatches endpoint must NOT be called
    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/dispatches"),
      expect.anything()
    );
  });

  it("reports stale queued/running jobs (>= 120m) without dispatching duplicate", async () => {
    const now = new Date("2026-11-24T05:00:00Z").getTime();
    const alerts: any[] = [];
    const mockFetch = vi.fn(async (url: string, init?: any) => {
      if (url.includes("/runs?")) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 99999999,
                status: "queued",
                created_at: "2026-11-24T02:30:00Z", // 150 min ago (> 120m)
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
    expect(alerts[0].message).toContain("Stale ingestion run detected: Run #99999999");
    // Ensure no duplicate workflow dispatch was initiated
    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/dispatches"),
      expect.anything()
    );
  });

  it("takes no action when ingestion cadence is healthy (< 285m since last success)", async () => {
    const now = new Date("2026-11-24T05:00:00Z").getTime();
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes("/runs?")) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 1111,
                status: "completed",
                conclusion: "success",
                updated_at: "2026-11-24T02:00:00Z", // 180 min ago (< 285m)
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes("/runs/1111/jobs")) {
        return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const res = await checkAndReconcileIngestion(baseEnv, mockFetch as any, now);
    expect(res.action).toBe("none");
    expect(res.reason).toContain("Ingestion cadence healthy");
    expect(res.overdueMinutes).toBe(180);
    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/dispatches"),
      expect.anything()
    );
  });

  it("dispatches catch-up workflow on main with watchdog: true when overdue (> 285m)", async () => {
    const now = new Date("2026-11-24T06:00:00Z").getTime();
    let dispatchedPayload: any = null;

    const mockFetch = vi.fn(async (url: string, init?: any) => {
      if (url.includes("/runs?")) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 2222,
                status: "completed",
                conclusion: "success",
                updated_at: "2026-11-24T01:00:00Z", // 300 min ago (> 285m)
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes("/runs/2222/jobs")) {
        return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
      }
      if (url.includes("/dispatches")) {
        dispatchedPayload = JSON.parse(init.body);
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    });

    const res = await checkAndReconcileIngestion(baseEnv, mockFetch as any, now);
    expect(res.action).toBe("dispatched");
    expect(res.overdueMinutes).toBe(300);
    expect(res.ref).toBe("main");

    // Verify exact cron-equivalent inputs with watchdog: true
    expect(dispatchedPayload).toEqual({
      ref: "main",
      inputs: {
        cohort: "both",
        mode: "write-production-expire",
        confirm: "WRITE PRODUCTION AND EXPIRE",
        watchdog: true,
      },
    });
  });

  it("inspects actual per-cohort outcomes and alerts when a cohort failed", async () => {
    const now = new Date("2026-11-24T03:00:00Z").getTime();
    const alerts: any[] = [];

    const mockFetch = vi.fn(async (url: string, init?: any) => {
      if (url.includes("/runs?")) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 3333,
                status: "completed",
                conclusion: "failure",
                updated_at: "2026-11-24T02:50:00Z",
              },
              {
                id: 3300,
                status: "completed",
                conclusion: "success",
                updated_at: "2026-11-24T01:00:00Z", // 120m ago
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes("/runs/3333/jobs")) {
        return new Response(
          JSON.stringify({
            jobs: [
              { name: "Validate run plan", conclusion: "success" },
              { name: "Python ingestion [non-workday] (write-production-expire)", conclusion: "failure" },
              { name: "Python ingestion [workday] (write-production-expire)", conclusion: "success" },
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
    expect(res.cohortsFailed).toEqual(["non-workday"]);
    expect(alerts.some((a) => a.alertType === "cohort_failed")).toBe(true);
  });

  it("alerts and throws error when workflow dispatch fails (e.g. 403 Forbidden)", async () => {
    const now = new Date("2026-11-24T06:00:00Z").getTime();
    const alerts: any[] = [];

    const mockFetch = vi.fn(async (url: string, init?: any) => {
      if (url.includes("/runs?")) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 4444,
                status: "completed",
                conclusion: "success",
                updated_at: "2026-11-24T00:00:00Z", // 360 min ago
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes("/runs/4444/jobs")) {
        return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
      }
      if (url.includes("/dispatches")) {
        return new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 403,
        });
      }
      if (url.includes("alerts.example.com")) {
        alerts.push(JSON.parse(init.body));
        return new Response("ok", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      checkAndReconcileIngestion(baseEnv, mockFetch as any, now)
    ).rejects.toThrow("Watchdog catch-up dispatch failed with status 403");

    expect(alerts.some((a) => a.alertType === "dispatch_failed")).toBe(true);
  });
});
