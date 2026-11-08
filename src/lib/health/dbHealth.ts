/** Read-only operational probe. Never logs credentials, DB rows or server errors. */
export interface DbTableMetric {
  name: string;
  live_tuples: number;
  dead_tuples: number;
  total_bytes: number;
}
export interface DbIndexMetric {
  name: string;
  scans: number;
  total_bytes: number;
  is_unique: boolean;
}
export interface DbHealthSnapshot {
  sampled_at: string;
  stats_reset: string | null;
  tables: DbTableMetric[];
  indexes: DbIndexMetric[];
  table_count: number;
  index_count: number;
  cron_available: boolean;
  failed_cron_24h: number | null;
}
export interface DbHealthReport {
  healthy: boolean;
  alerts: string[];
  advisoryUnusedIndexes: number;
  tableBytes: number;
  tablesSampled: number;
  indexesSampled: number;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasName(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

/** Reject incomplete/corrupt RPC results rather than reporting a false green. */
export function parseDbHealthSnapshot(raw: unknown): DbHealthSnapshot {
  if (!isRecord(raw) || !isDate(raw.sampled_at) ||
      !(raw.stats_reset === null || isDate(raw.stats_reset)) ||
      !isCount(raw.table_count) || !isCount(raw.index_count) ||
      typeof raw.cron_available !== "boolean" ||
      !(raw.failed_cron_24h === null || isCount(raw.failed_cron_24h)) ||
      (raw.cron_available && raw.failed_cron_24h === null) ||
      !Array.isArray(raw.tables) || !Array.isArray(raw.indexes) ||
      raw.tables.length > 100 || raw.indexes.length > 100 ||
      raw.tables.length !== Math.min(raw.table_count, 100) ||
      raw.indexes.length !== Math.min(raw.index_count, 100)) {
    throw new Error("Invalid DB health snapshot");
  }
  for (const table of raw.tables) {
    if (!isRecord(table) || !hasName(table.name) || !isCount(table.live_tuples) ||
        !isCount(table.dead_tuples) || !isCount(table.total_bytes)) {
      throw new Error("Invalid DB health table metrics");
    }
  }
  for (const index of raw.indexes) {
    if (!isRecord(index) || !hasName(index.name) || !isCount(index.scans) ||
        !isCount(index.total_bytes) || typeof index.is_unique !== "boolean") {
      throw new Error("Invalid DB health index metrics");
    }
  }
  return raw as unknown as DbHealthSnapshot;
}

/** Chosen defaults, not evidence that a table/index needs maintenance. */
export function evaluateDbHealth(raw: unknown, nowMs = Date.now()): DbHealthReport {
  const snapshot = parseDbHealthSnapshot(raw);
  const alerts: string[] = [];
  const sampledAt = Date.parse(snapshot.sampled_at);
  if (!Number.isFinite(nowMs) || sampledAt > nowMs + 60_000 || nowMs - sampledAt > 300_000) {
    alerts.push("stale_or_future_snapshot");
  }
  if (!snapshot.cron_available) alerts.push("cron_metrics_unavailable");
  if ((snapshot.failed_cron_24h ?? 0) > 0) alerts.push("failed_cron_last_24h");
  if (snapshot.table_count === 0) alerts.push("no_public_tables");
  if (snapshot.table_count > 100 || snapshot.index_count > 100) alerts.push("metrics_truncated");
  const deadTupleTables = snapshot.tables.filter((t) =>
    t.dead_tuples >= 1000 && t.dead_tuples / (t.live_tuples + t.dead_tuples) >= 0.2,
  ).length;
  if (deadTupleTables > 0) alerts.push("dead_tuple_pressure");
  const resetMs = snapshot.stats_reset === null ? NaN : Date.parse(snapshot.stats_reset);
  const statsOldEnough = Number.isFinite(resetMs) && nowMs - resetMs >= 7 * 86400_000;
  const unused = statsOldEnough ? snapshot.indexes.filter((i) =>
    !i.is_unique && i.scans === 0 && i.total_bytes >= 50 * 1024 * 1024,
  ).length : 0;
  return {
    healthy: alerts.length === 0,
    alerts,
    advisoryUnusedIndexes: unused,
    tableBytes: snapshot.tables.reduce((sum, t) => sum + t.total_bytes, 0),
    tablesSampled: snapshot.tables.length,
    indexesSampled: snapshot.indexes.length,
  };
}

/** Exactly one bounded read-only RPC. Any HTTP/network/JSON failure stays redacted. */
export async function probeDbHealth(
  url: string,
  serviceKey: string,
  fetcher: typeof fetch = fetch,
): Promise<DbHealthReport> {
  const base = new URL(url);
  if (base.protocol !== "https:" || base.username || base.password || !serviceKey.trim()) {
    throw new Error("Invalid DB health configuration");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(new URL("/rest/v1/rpc/db_health_snapshot", base), {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("DB health RPC failed");
    return evaluateDbHealth(await response.json());
  } catch {
    throw new Error("DB health probe unavailable");
  } finally {
    clearTimeout(timer);
  }
}
