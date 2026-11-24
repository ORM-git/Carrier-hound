/**
 * Supabase (PostgREST) adapter for the read-only company inventory. Selects only.
 * Every read is proven complete: an exact count, then offset pages in a fixed key order until that many rows
 * arrive. A server row cap below the requested page size is handled by paging further; a short read, a total that
 * changes mid-read, a duplicate key or a missing count fails the whole inventory instead of returning partial data.
 * Ordering keys are primary keys that this schema never updates, so a concurrent insert or delete shows up as a
 * changed count; a key rewritten mid-read without a count change is outside what offset paging can detect.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { CANARY_TABLES, type CanaryTable } from "./canary";
import type { InventoryBoard, InventoryCompany, InventoryStore } from "./inventory";

/** Rows asked for per request; PostgREST may return fewer (max-rows), which only costs more requests. */
export const INVENTORY_READ_PAGE = 500;
/** Upper bound on requests for any single read, so a tiny server cap or a runaway table fails instead of looping. */
export const INVENTORY_MAX_REQUESTS_PER_READ = 400;
/** Active-job counts are one head-only exact count per company; at most this many are in flight at once. */
export const INVENTORY_COUNT_CONCURRENCY = 4;

const ORDER: Record<CanaryTable, readonly string[]> = {
  company_profile_facts: ["company_id", "fact_key"],
  company_profile_leadership: ["id"],
  company_profile_news: ["id"],
  company_profile_refresh_state: ["company_id"],
};
const IDENTITY = /^[a-z0-9.-]+$/;

interface PageResult<T> { data: T[] | null; error: { message: string } | null; count: number | null }

export async function readComplete<T>(
  what: string,
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  options: { key: (row: T) => string; max?: number; pageSize?: number; maxRequests?: number },
): Promise<T[]> {
  const pageSize = options.pageSize ?? INVENTORY_READ_PAGE;
  const maxRequests = options.maxRequests ?? INVENTORY_MAX_REQUESTS_PER_READ;
  const rows: T[] = [];
  const seen = new Set<string>();
  let total: number | null = null;
  for (let request = 1; ; request++) {
    if (request > maxRequests) throw new Error(`${what}: read needs more than ${maxRequests} requests; refusing an unbounded read`);
    const want = Math.min(total ?? Infinity, options.max ?? Infinity);
    const from = rows.length;
    const result = await page(from, from + Math.min(pageSize, want - from) - 1);
    if (result.error) throw new Error(`${what} failed: ${result.error.message}`);
    if (typeof result.count !== "number") throw new Error(`${what}: no exact count returned, so completeness cannot be proven`);
    if (total === null) total = result.count;
    else if (result.count !== total) throw new Error(`${what}: row count changed during the read (${total} then ${result.count}); rerun the inventory`);
    const data = result.data || [];
    for (const row of data) {
      const key = options.key(row);
      if (seen.has(key)) throw new Error(`${what}: duplicate row ${key} across pages (data moved during the read); rerun the inventory`);
      seen.add(key);
      rows.push(row);
    }
    const target = Math.min(total, options.max ?? Infinity);
    if (rows.length >= target) return rows.slice(0, target);
    if (!data.length) throw new Error(`${what}: incomplete read, ${rows.length} of ${target} rows returned`);
  }
}

/** Runs fn over items with at most `limit` calls in flight; the first failure stops new calls and is rethrown. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { out[index] = await fn(items[index]); } catch (error) { failed = true; throw error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any generated or untyped client works; only .from() reads are used
export function supabaseInventoryStore(supabase: SupabaseClient<any, any, any, any, any>, options: { pageSize?: number; countConcurrency?: number } = {}): InventoryStore {
  const read = <T>(what: string, page: (from: number, to: number) => PromiseLike<PageResult<T>>, key: (row: T) => string, max?: number) =>
    readComplete(what, page, { key, max, pageSize: options.pageSize });
  return {
    companiesAfter(afterId, limit) {
      return read<InventoryCompany>("Company inventory", (from, to) => {
        let query = supabase.from("companies").select("id,name,canonical_domain", { count: "exact" }).order("id", { ascending: true });
        if (afterId) query = query.gt("id", afterId);
        return query.range(from, to) as unknown as PromiseLike<PageResult<InventoryCompany>>;
      }, (row) => row.id, limit);
    },
    async domainCandidates(identities) {
      if (!identities.length) return [];
      if (identities.some((d) => !IDENTITY.test(d))) throw new Error("Domain identity contains characters outside a hostname");
      // Case-insensitive substring match over the whole table catches scheme, path, www. and mixed-case forms; the planner normalizes.
      const filter = identities.map((d) => `canonical_domain.ilike.*${d}*`).join(",");
      return read<{ id: string; canonical_domain: string | null }>("Domain ownership lookup", (from, to) =>
        supabase.from("companies").select("id,canonical_domain", { count: "exact" }).or(filter).order("id", { ascending: true }).range(from, to) as unknown as PromiseLike<PageResult<{ id: string; canonical_domain: string | null }>>,
      (row) => row.id);
    },
    async boards(companyIds) {
      const rows = await read<InventoryBoard>("ATS board lookup", (from, to) =>
        supabase.from("company_boards").select("id,company_id,enabled,ats_type,slug,careers_url", { count: "exact" }).in("company_id", companyIds).order("id", { ascending: true }).range(from, to) as unknown as PromiseLike<PageResult<InventoryBoard>>,
      (row) => row.id);
      return rows.map((b) => ({ ...b, enabled: b.enabled === true }));
    },
    async activeJobCounts(companyIds) {
      const counts = await mapWithConcurrency(companyIds, options.countConcurrency ?? INVENTORY_COUNT_CONCURRENCY, async (id) => {
        const { count, error, status } = await supabase.from("jobs").select("id", { count: "exact", head: true }).eq("company_id", id).eq("status", "active").eq("is_active", true);
        if (error) throw new Error(`Active job count failed: ${error.message || `HTTP ${status}`}`); // a HEAD error has no body
        if (typeof count !== "number") throw new Error("Active job count: no exact count returned");
        return count;
      });
      return Object.fromEntries(companyIds.map((id, i) => [id, counts[i]]));
    },
    rows(table, companyIds) {
      const columns = CANARY_TABLES[table].columns;
      return read<Record<string, unknown>>(`${table} lookup`, (from, to) => {
        let query = supabase.from(table).select(columns.join(","), { count: "exact" }).in("company_id", companyIds);
        for (const column of ORDER[table]) query = query.order(column, { ascending: true });
        return query.range(from, to) as unknown as PromiseLike<PageResult<Record<string, unknown>>>;
      }, (row) => ORDER[table].map((c) => String(row[c])).join("|"));
    },
  };
}
