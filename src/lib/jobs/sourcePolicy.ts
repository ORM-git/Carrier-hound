/**
 * Job sources hidden from every app surface: lists, counts, direct details, hydration, digests.
 * Hiding is read-side only: rows stay in the database untouched, so reverting this filter shows them again.
 *
 * jobspy = LinkedIn / Indeed / Naukri imported through python-jobspy (no longer imported; see
 * scripts/scraper/fetch_aggregators_and_india.py BLOCKED_JOBSPY_SITES).
 */
export const HIDDEN_SOURCE_TYPE = "jobspy";

/** PostgREST `or` filter for visible rows. `source_type=neq.jobspy` alone would also drop NULL source_type rows. */
export const VISIBLE_SOURCE_FILTER = `source_type.is.null,source_type.neq.${HIDDEN_SOURCE_TYPE}`;

/** Same rule for a row already in memory. */
export function isHiddenSource(row: { source_type?: string | null } | null | undefined): boolean {
  return row?.source_type === HIDDEN_SOURCE_TYPE;
}
