/**
 * Guarded update helper for the row_version column (migration
 * 20261107d_row_version_optimistic_lock.sql, NOT APPLIED). Nothing in the repo
 * calls it yet. Until the migration is applied, the column does not exist and a
 * call returns { status: "error" }.
 *
 * Semantics: UPDATE ... WHERE <key> = <value> AND row_version = <expected>.
 *   ok        one row updated (its new row_version is returned)
 *   stale     no row matched the version but the row exists: someone else wrote
 *             first; currentVersion is what is stored now (caller re-reads, merges)
 *   not_found no row with that key
 *   error     the query failed (message only)
 */
export const VERSIONED_TABLES = {
  user_preferences: "user_id",
  resumes: "id",
  applications: "id",
  candidate_profiles: "user_id",
} as const;

export type VersionedTable = keyof typeof VERSIONED_TABLES;

export type VersionedUpdateResult =
  | { status: "ok"; row: Record<string, unknown>; rowVersion: number }
  | { status: "stale"; currentVersion: number | null }
  | { status: "not_found" }
  | { status: "error"; message: string };

export async function updateWithVersion(
  supabase: any,
  table: VersionedTable,
  keyValue: string,
  expectedVersion: number,
  patch: Record<string, unknown>
): Promise<VersionedUpdateResult> {
  if (!Object.prototype.hasOwnProperty.call(VERSIONED_TABLES, table)) {
    throw new Error(`optimisticLock: ${String(table)} is not a versioned table`);
  }
  const keyCol = VERSIONED_TABLES[table];
  if (typeof expectedVersion !== "number" || !isFinite(expectedVersion) || Math.floor(expectedVersion) !== expectedVersion || expectedVersion < 1) {
    throw new Error("optimisticLock: expectedVersion must be a positive integer");
  }
  if ("row_version" in patch) throw new Error("optimisticLock: patch must not set row_version");
  try {
    const upd = await supabase
      .from(table)
      .update(patch)
      .eq(keyCol, keyValue)
      .eq("row_version", expectedVersion)
      .select();
    if (upd.error) return { status: "error", message: String(upd.error.message || "update failed") };
    const rows: any[] = upd.data || [];
    if (rows.length > 0) return { status: "ok", row: rows[0], rowVersion: Number(rows[0].row_version) };
    const cur = await supabase.from(table).select("row_version").eq(keyCol, keyValue).maybeSingle();
    if (cur.error) return { status: "error", message: String(cur.error.message || "read failed") };
    if (!cur.data) return { status: "not_found" };
    return { status: "stale", currentVersion: typeof cur.data.row_version === "number" ? cur.data.row_version : null };
  } catch (err: any) {
    return { status: "error", message: String(err && err.message ? err.message : err) };
  }
}
