/**
 * Slow Query Visibility & Aggregation (Database sheet: Slow-query log).
 *
 * Provides parameter-stripping redaction, truncation, and top-10 aggregation
 * by total execution time for pg_stat_statements outputs during scheduled DB health runs.
 *
 * Guarantees:
 * - Redacts string literals (standard & dollar-quoted), numbers, UUIDs, hex values, and parameters to '?'.
 * - Truncates query text strictly within bounded length (output length <= maxLen, e.g. <= 120 chars).
 * - Aggregates top-N by total time (calls, total_ms, mean_ms, max_ms).
 * - Excludes internal pg_stat_statements monitoring queries.
 * - Zero raw literals or user PII ever printed.
 * - Missing or failing get_slow_queries RPC fails visibly with an explicit Error.
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
 * Strips all literal values (strings, dollar-quoted strings, numbers, UUIDs, params) and comments
 * from a SQL query string, and truncates strictly within maxLen (length <= maxLen).
 */
export function redactAndTruncateQuery(query: string, maxLen = 120): string {
  if (!query || typeof query !== "string") {
    return "";
  }

  let text = query;

  // 1. Strip block comments /* ... */ and line comments -- ...
  text = text.replace(/\/\*[\s\S]*?\*\//g, " ");
  text = text.replace(/--.*$/gm, " ");

  // 2. Strip PostgreSQL dollar-quoted string literals ($$...$$ and $tag$...$tag$)
  text = text.replace(/(\$[a-zA-Z_0-9]*\$)[\s\S]*?\1/g, "'?'");

  // 3. Strip standard single-quoted string literals ('...' including escaped quotes '')
  text = text.replace(/'(?:''|[^'])*'/g, "'?'");

  // 4. Strip standard UUID literals (8-4-4-4-12 hex)
  text = text.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "?");

  // 5. Strip hex literals (0x...)
  text = text.replace(/\b0x[0-9a-fA-F]+\b/gi, "?");

  // 6. Normalize postgres parameter placeholders ($1, $2, etc.) to '?'
  text = text.replace(/\$[0-9]+/g, "?");

  // 7. Strip numeric literals (integers and floating points, e.g. 100, 3.14)
  text = text.replace(/\b\d+(?:\.\d+)?\b/g, "?");

  // 8. Collapse repeated '?' or lists of (?, ?, ?) to (?)
  text = text.replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, "(?)");

  // 9. Collapse whitespace to single space and trim
  text = text.replace(/\s+/g, " ").trim();

  // 10. Truncate to max length without exceeding maxLen
  if (maxLen <= 0) return "";
  if (text.length > maxLen) {
    if (maxLen <= 3) {
      return text.slice(0, maxLen);
    }
    return text.slice(0, maxLen - 3).trimEnd() + "...";
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
 * Fetches slow queries via Supabase REST RPC.
 * Fails loudly with an informative Error if the RPC is missing or fails.
 */
export async function probeSlowQueries(
  url: string,
  serviceKey: string,
  fetcher: typeof fetch = fetch
): Promise<SlowQuerySummary[]> {
  const base = new URL(url);
  if (base.protocol !== "https:" || !serviceKey.trim()) {
    throw new Error("Invalid Supabase URL or empty service key for slow query probe");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  try {
    const rpcUrl = new URL("/rest/v1/rpc/get_slow_queries", base);
    const response = await fetcher(rpcUrl, {
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
      const errText = await response.text().catch(() => "");
      throw new Error(
        `get_slow_queries RPC failed with HTTP ${response.status}: ${
          errText || response.statusText || "RPC missing from schema cache or unauthorized"
        }`
      );
    }

    const data = await response.json();
    return aggregateSlowQueries(data, 10);
  } catch (err: any) {
    throw new Error(`probeSlowQueries failed: ${err?.message || "network error"}`);
  } finally {
    clearTimeout(timer);
  }
}
