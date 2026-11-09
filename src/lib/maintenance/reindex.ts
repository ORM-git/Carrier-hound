/** Result rows returned by public.reindex_bloated_indexes. */
export type ReindexRow = {
  schema_name: string;
  table_name: string;
  index_name: string;
  size_bytes: number;
  size_pretty: string;
  action: string;
};

/** RPC success does not mean every index rebuilt successfully. */
export function summarizeReindexResults(rows: readonly ReindexRow[]) {
  const reindexed = rows.filter((row) => row.action === "reindexed").length;
  const failed = rows.filter((row) => row.action === "failed").length;
  return {
    reindexed,
    failed,
    status: failed > 0 ? "failed" as const : "success" as const,
    errorMessage: failed > 0 ? `${failed} of ${rows.length} index maintenance operations failed` : null,
  };
}
