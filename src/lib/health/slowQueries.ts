/**
 * Slow Query Visibility & Aggregation (Database sheet: Slow-query log).
 *
 * Provides parameter-stripping redaction, truncation, and top-10 aggregation
 * by total execution time for pg_stat_statements outputs during scheduled DB health runs.
 *
 * Guarantees:
 * - Redacts string literals, numbers, UUIDs, hex values, and parameters to '?'.
 * - Truncates query text to bounded length (default 120 chars).
 * - Aggregates top-N by total time (calls, total_ms, mean_ms, max_ms).
 * - Excludes internal pg_stat_statements monitoring queries.
 * - Zero raw literals or user PII ever printed.
 */

export interface RawSlowQueryEntry {
  query?: unknown;
  calls?: unknown;
  total_exec_time?: unknown;
  total_time?: unknown;
  total_ms?: unknown;
  mean_exec_time?: unknown;
  mean_time?: unknown;
  mean_ms?: unknown;
  max_exec_time?: unknown;
  max_time?: unknown;
  max_ms?: unknown;
  [key: string]: unknown;
}

export interface SlowQuerySummary {
  query: string;
  calls: number;
  total_ms: number;
  mean_ms: number;
  max_ms: number;
}

/**
 * Strips all literal values (strings, numbers, UUIDs, params) and comments
 * from a SQL query string, and truncates to maxLen.
 */
export function redactAndTruncateQuery(query: string, maxLen = 120): string {
  if (!query || typeof query !== "string") {
    return "";
  }

  let text = query;

  // 1. Strip block comments /* ... */ and line comments -- ...
  text = text.replace(/\/\*[\s\S]*?\*\//g, " ");
  text = text.replace(/--.*$/gm, " ");

  // 2. Strip string literals ('...' including escaped quotes '')
  text = text.replace(/'(?:''|[^'])*'/g, "'?'");

  // 3. Strip standard UUID literals (8-4-4-4-12 hex)
  text = text.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "?");

  // 4. Strip hex literals (0x...)
  text = text.replace(/\b0x[0-9a-fA-F]+\b/gi, "?");

  // 5. Normalize postgres parameter placeholders ($1, $2, etc.) to '?'
  text = text.replace(/\$[0-9]+/g, "?");

  // 6. Strip numeric literals (integers and floating points, e.g. 100, 3.14)
  text = text.replace(/\b\d+(?:\.\d+)?\b/g, "?");

  // 7. Collapse repeated '?' or lists of (?, ?, ?) to (?)
  text = text.replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, "(?)");

  // 8. Collapse whitespace to single space and trim
  text = text.replace(/\s+/g, " ").trim();

  // 9. Truncate to max length
  if (text.length > maxLen) {
    return text.slice(0, maxLen).trim() + "...";
  }

  return text;
}

function parseNumber(val: unknown): number {
  if (typeof val === "number" && Number.isFinite(val)) {
    return Math.round(val * 10) / 10;
  }
  if (typeof val === "string") {
    const parsed = parseFloat(val);
    if (Number.isFinite(parsed)) {
      return Math.round(parsed * 10) / 10;
    }
  }
  return 0;
}

function parseCalls(val: unknown): number {
  if (typeof val === "number" && Number.isSafeInteger(val) && val >= 0) {
    return val;
  }
  if (typeof val === "string") {
    const parsed = parseInt(val, 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 0;
}

/**
 * Aggregates raw query stats into the top N entries sorted descending by total time.
 */
export function aggregateSlowQueries(
  rawList: unknown,
  limit = 10
): SlowQuerySummary[] {
  if (!Array.isArray(rawList)) {
    return [];
  }

  const parsedEntries: SlowQuerySummary[] = [];

  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const entry = item as RawSlowQueryEntry;
    const rawQuery = typeof entry.query === "string" ? entry.query : "";

    // Exclude empty queries and internal pg_stat_statements queries
    if (!rawQuery.trim() || /pg_stat_statements/i.test(rawQuery)) {
      continue;
    }

    const totalTime = parseNumber(entry.total_ms ?? entry.total_exec_time ?? entry.total_time);
    const meanTime = parseNumber(entry.mean_ms ?? entry.mean_exec_time ?? entry.mean_time);
    const maxTime = parseNumber(entry.max_ms ?? entry.max_exec_time ?? entry.max_time);
    const calls = parseCalls(entry.calls);

    const redacted = redactAndTruncateQuery(rawQuery, 120);

    parsedEntries.push({
      query: redacted,
      calls,
      total_ms: totalTime,
      mean_ms: meanTime,
      max_ms: maxTime,
    });
  }

  // Sort descending by total_ms
  parsedEntries.sort((a, b) => b.total_ms - a.total_ms);

  return parsedEntries.slice(0, limit);
}

/**
 * Fetches slow queries via Supabase REST RPC if configured, returning
 * empty array fail-safe if RPC is absent or unconfigured.
 */
export async function probeSlowQueries(
  url: string,
  serviceKey: string,
  fetcher: typeof fetch = fetch
): Promise<SlowQuerySummary[]> {
  const base = new URL(url);
  if (base.protocol !== "https:" || !serviceKey.trim()) {
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetcher(new URL("/rest/v1/rpc/get_slow_queries", base), {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: controller.signal,
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return aggregateSlowQueries(data, 10);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
