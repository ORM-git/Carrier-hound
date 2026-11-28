/**
 * /api/radar "data as of" stamp: the finished_at of the latest TypeScript ingest run (newest started_at).
 *
 * Python health rows (scripts/scraper/health_record.py, marked by per_source_counts.python_run) are excluded
 * before ordering: one with a null started_at would otherwise sort first under DESC (Postgres puts NULLs first)
 * and a failed Python run would advance the stamp. That is all the stamp means. A failed TypeScript run can
 * still advance it, and it can lag a successful Python write.
 */
export interface RadarRunMeta {
  finished_at: string | null;
  total_active: number | null;
  total_verified: number | null;
}

export const PYTHON_RUN_FILTER_COLUMN = "per_source_counts->python_run";

// Minimal shape of the supabase-js query builder this helper uses (keeps the helper testable with a fake).
interface RunMetaQuery {
  select(columns: string): RunMetaQuery;
  is(column: string, value: null): RunMetaQuery;
  order(column: string, options: { ascending: boolean }): RunMetaQuery;
  limit(count: number): RunMetaQuery;
  maybeSingle(): PromiseLike<{ data: RadarRunMeta | null; error?: unknown }>;
}

export async function fetchLatestTypescriptRunMeta(supabase: { from(table: string): unknown }): Promise<RadarRunMeta | null> {
  const query = supabase.from("ingest_runs") as RunMetaQuery;
  const { data } = await query
    .select("finished_at, total_active, total_verified")
    .is(PYTHON_RUN_FILTER_COLUMN, null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}
