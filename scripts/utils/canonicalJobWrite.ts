/**
 * Canonical write identity for public.jobs: (source_id, source_job_id).
 *
 * The unique index idx_jobs_source_id_source_job_id_uniq is PARTIAL (WHERE source_id IS NOT NULL
 * AND source_job_id IS NOT NULL). Postgres only infers a partial index for ON CONFLICT when the
 * predicate is repeated, which PostgREST's onConflict cannot send, so
 * `upsert(..., { onConflict: 'source_id,source_job_id' })` would fail every write. Instead the
 * existing row is looked up by canonical identity and updated by primary key; the rest is inserted.
 * The unique index still rejects a concurrent duplicate insert (fails loudly, never duplicates).
 */

import { assertCanonicalSourceIds } from "../../src/lib/jobs/highVolumeEnrichment";

/** True only for "column does not exist" (Postgres 42703 / PostgREST PGRST204), not for transient errors. */
export function isMissingColumnError(err: any): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  return /column .* does not exist|could not find the .* column/i.test(String(err.message || ""));
}

/**
 * Probes whether public.jobs has `column`. Returns false only when the column is truly missing;
 * any other error is retried and then thrown, so a transient failure can never make ingest
 * omit source_id (a NULL source_id would bypass the partial unique index).
 */
export async function probeJobsColumn(
  supabase: any,
  column: string,
  opts: { attempts?: number; delayMs?: number } = {}
): Promise<boolean> {
  const attempts = opts.attempts ?? 3;
  let lastErr: any = null;
  for (let i = 0; i < attempts; i++) {
    const { error } = await supabase.from("jobs").select(column).limit(1);
    if (!error) return true;
    if (isMissingColumnError(error)) return false;
    lastErr = error;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, opts.delayMs ?? 500));
  }
  throw new Error(`Schema probe for jobs.${column} failed after ${attempts} attempts: ${lastErr?.message || lastErr}`);
}

export interface JobIdentityRow {
  source: string;
  source_job_id: string;
  source_id?: string | null;
}

export interface ExistingJobRef {
  id: string;
  /** The existing row's source; kept on update so the legacy (source, source_job_id) key never collides. */
  source: string;
}

const LOOKUP_CHUNK = 100;

async function selectIn(supabase: any, cols: string, eqCol: string, eqVal: string, ids: string[]): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from("jobs")
      .select(cols)
      .eq(eqCol, eqVal)
      .in("source_job_id", ids.slice(i, i + LOOKUP_CHUNK));
    // Never guess on a failed lookup: an unseen existing row would be re-inserted as a duplicate.
    if (error) throw new Error(`jobs identity lookup failed: ${error.message || error}`);
    if (Array.isArray(data)) out.push(...data);
  }
  return out;
}

function groupIds<T extends JobIdentityRow>(rows: T[], key: (r: T) => string | null | undefined): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const g = groups.get(k);
    if (g) g.push(r.source_job_id);
    else groups.set(k, [r.source_job_id]);
  }
  return groups;
}

/**
 * Finds the existing jobs row for each input row, scoped to its own identity:
 * - canonical: same (source_id, source_job_id); else a legacy row with the same (source, source_job_id)
 *   whose source_id is NULL or equal (never a row that belongs to another canonical identity).
 * - legacy schema (no source_id column): same (source, source_job_id) only.
 * Never matches by apply URL. Returns one entry per input row (undefined = new).
 */
export async function findExistingJobs<T extends JobIdentityRow>(
  supabase: any,
  rows: T[],
  opts: { canonical: boolean }
): Promise<Array<ExistingJobRef | undefined>> {
  const byCanonical = new Map<string, ExistingJobRef>();
  const byLegacy = new Map<string, ExistingJobRef & { source_id?: string | null }>();

  if (opts.canonical) {
    for (const [sourceId, ids] of groupIds(rows, (r) => r.source_id)) {
      for (const row of await selectIn(supabase, "id, source, source_id, source_job_id", "source_id", sourceId, ids)) {
        byCanonical.set(`${row.source_id}\u0000${row.source_job_id}`, { id: row.id, source: row.source });
      }
    }
  }
  const legacyCols = opts.canonical ? "id, source, source_id, source_job_id" : "id, source, source_job_id";
  for (const [source, ids] of groupIds(rows, (r) => r.source)) {
    for (const row of await selectIn(supabase, legacyCols, "source", source, ids)) {
      byLegacy.set(`${row.source}\u0000${row.source_job_id}`, row);
    }
  }

  return rows.map((r) => {
    if (opts.canonical) {
      const hit = byCanonical.get(`${r.source_id}\u0000${r.source_job_id}`);
      if (hit) return hit;
    }
    const legacy = byLegacy.get(`${r.source}\u0000${r.source_job_id}`);
    if (!legacy) return undefined;
    if (opts.canonical && legacy.source_id && legacy.source_id !== r.source_id) return undefined;
    return { id: legacy.id, source: legacy.source };
  });
}

/**
 * Writes rows keyed on canonical (source_id, source_job_id): existing rows are updated by id
 * (keeping their source), new rows are inserted. With allowUpdates=false existing rows are skipped.
 * Throws on any error so the caller's rollback/abort handling runs.
 */
export async function writeJobsByCanonicalIdentity<T extends JobIdentityRow & Record<string, any>>(
  supabase: any,
  rows: T[],
  opts: { allowUpdates: boolean }
): Promise<{ inserted: number; updated: number; skippedExisting: number }> {
  assertCanonicalSourceIds(rows);
  const existing = await findExistingJobs(supabase, rows, { canonical: true });

  const updates: Array<Record<string, any>> = [];
  const inserts: Array<Record<string, any>> = [];
  rows.forEach((r, i) => {
    // created_at is the DB insert time (default now()) behind the ticker's added_at: an update
    // or retry must never reset it, and a source-supplied value must never backdate an insert.
    const { created_at: _createdAt, ...row } = r;
    const hit = existing[i];
    if (hit) updates.push({ ...row, id: hit.id, source: hit.source });
    else inserts.push(row);
  });

  if (opts.allowUpdates && updates.length > 0) {
    const { error } = await supabase.from("jobs").upsert(updates, { onConflict: "id" });
    if (error) throw new Error(`jobs canonical update failed: ${error.message || error}`);
  }
  if (inserts.length > 0) {
    const { error } = await supabase.from("jobs").insert(inserts);
    if (error) throw new Error(`jobs canonical insert failed: ${error.message || error}`);
  }
  return {
    inserted: inserts.length,
    updated: opts.allowUpdates ? updates.length : 0,
    skippedExisting: opts.allowUpdates ? 0 : updates.length,
  };
}
