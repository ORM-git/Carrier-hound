import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { evaluateDbHealth, parseDbHealthSnapshot, probeDbHealth } from "../health/dbHealth";

const NOW = Date.parse("2026-11-08T18:00:00Z");
function snapshot() {
  return {
    sampled_at: new Date(NOW).toISOString(),
    stats_reset: new Date(NOW - 8 * 86400_000).toISOString(),
    tables: [{ name: "jobs", live_tuples: 10000, dead_tuples: 10, total_bytes: 1000000 }],
    indexes: [{ name: "jobs_pkey", scans: 0, total_bytes: 100000000, is_unique: true }],
    table_count: 1, index_count: 1, cron_available: true, failed_cron_24h: 0,
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("DB health evaluation", () => {
  it("reports healthy metrics and size without treating unique indexes as unused", () => {
    expect(evaluateDbHealth(snapshot(), NOW)).toEqual({
      healthy: true, alerts: [], advisoryUnusedIndexes: 0,
      tableBytes: 1000000, tablesSampled: 1, indexesSampled: 1,
    });
  });
  it("alerts on failed cron runs, missing cron metrics and zero public tables", () => {
    expect(evaluateDbHealth({ ...snapshot(), failed_cron_24h: 1 }, NOW).alerts)
      .toContain("failed_cron_last_24h");
    expect(evaluateDbHealth({ ...snapshot(), cron_available: false, failed_cron_24h: null }, NOW).healthy)
      .toBe(false);
    expect(evaluateDbHealth({ ...snapshot(), tables: [], table_count: 0 }, NOW).alerts)
      .toContain("no_public_tables");
  });
  it("uses dead / (live + dead), including all-dead tables, with a 1000-tuple floor", () => {
    const raw = snapshot();
    raw.tables[0].live_tuples = 0; raw.tables[0].dead_tuples = 1000;
    expect(evaluateDbHealth(raw, NOW).alerts).toContain("dead_tuple_pressure");
    raw.tables[0].dead_tuples = 999;
    expect(evaluateDbHealth(raw, NOW).alerts).not.toContain("dead_tuple_pressure");
    raw.tables[0].live_tuples = 4000; raw.tables[0].dead_tuples = 1000;
    expect(evaluateDbHealth(raw, NOW).healthy).toBe(false);
    raw.tables[0].live_tuples = 4001;
    expect(evaluateDbHealth(raw, NOW).healthy).toBe(true);
  });
  it("only flags large nonunique unused indexes after seven days of stats", () => {
    const raw = snapshot(); raw.indexes[0].is_unique = false;
    expect(evaluateDbHealth(raw, NOW).advisoryUnusedIndexes).toBe(1);
    raw.stats_reset = new Date(NOW).toISOString();
    expect(evaluateDbHealth(raw, NOW).advisoryUnusedIndexes).toBe(0);
    expect(evaluateDbHealth({ ...raw, stats_reset: null }, NOW).advisoryUnusedIndexes).toBe(0);
  });
  it("rejects stale/future samples and warns when the bounded inventory is truncated", () => {
    for (const offset of [-300001, 60001]) {
      expect(evaluateDbHealth({ ...snapshot(), sampled_at: new Date(NOW + offset).toISOString() }, NOW).healthy)
        .toBe(false);
    }
    const raw = snapshot(); raw.table_count = 101;
    raw.tables = Array.from({ length: 100 }, (_, n) => ({ ...raw.tables[0], name: `t${n}` }));
    expect(evaluateDbHealth(raw, NOW).alerts).toContain("metrics_truncated");
  });
  it.each([
    null, {}, { ...snapshot(), table_count: -1 },
    { ...snapshot(), failed_cron_24h: null },
    { ...snapshot(), tables: [] },
    { ...snapshot(), tables: [{ ...snapshot().tables[0], dead_tuples: NaN }] },
    { ...snapshot(), indexes: [{ ...snapshot().indexes[0], scans: Number.MAX_SAFE_INTEGER + 1 }] },
  ])("fails closed on malformed or incomplete metrics %#", (raw) => {
    expect(() => parseDbHealthSnapshot(raw)).toThrow();
  });
});

describe("DB health RPC transport", () => {
  it("makes one service-authenticated RPC and returns only aggregate output", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot())));
    const report = await probeDbHealth("https://example.supabase.co", "test-key", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://example.supabase.co/rest/v1/rpc/db_health_snapshot");
    expect(init.method).toBe("POST"); expect(init.body).toBe("{}");
    expect(init.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.stringify(report)).not.toMatch(/jobs|test-key/);
  });
  it.each(["http://example.test", "https://user:pass@example.test"])("rejects unsafe configuration %s", async (url) => {
    const fetcher = vi.fn();
    await expect(probeDbHealth(url, "key", fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("redacts HTTP and network failures", async () => {
    const httpFail = vi.fn().mockResolvedValue(new Response("private error", { status: 503 }));
    const networkFail = vi.fn().mockRejectedValue(new Error("credential-value"));
    for (const fetcher of [httpFail, networkFail]) {
      await expect(probeDbHealth("https://example.test", "secret", fetcher))
        .rejects.toThrow("DB health probe unavailable");
    }
  });
  it("aborts a stalled request after ten seconds", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const probe = probeDbHealth("https://example.test", "secret", fetcher);
    const check = expect(probe).rejects.toThrow("DB health probe unavailable");
    await vi.advanceTimersByTimeAsync(10000);
    await check;
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  });
});

const ROOT = path.resolve(__dirname, "..", "..", "..");
describe("DB health migration and activation boundaries", () => {
  it("pins search path, denies public callers and has no maintenance writes", () => {
    const sql = readFileSync(path.join(ROOT, "supabase/migrations/20261108b_db_health_snapshot.sql"), "utf8");
    expect(sql).toContain("STATUS: NOT APPLIED");
    expect(sql).toContain("SET search_path = pg_catalog");
    expect(sql).toContain("FROM PUBLIC, anon, authenticated");
    expect(sql).toContain("TO service_role");
    const body = sql.split("AS $function$")[1].split("$function$;")[0];
    expect(body).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|VACUUM|REINDEX)\b/i);
    expect(body).not.toMatch(/\bquery\b/i);
  });
  it("leaves scheduled and manual runs inert until the explicit activation variable", () => {
    const workflow = readFileSync(path.join(ROOT, ".github/workflows/db-health-probe.yml"), "utf8");
    expect(workflow).toContain("vars.DB_HEALTH_PROBE_ENABLED == 'true'");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toMatch(/issues: write|curl|psql|apply-pending/);
  });
});
