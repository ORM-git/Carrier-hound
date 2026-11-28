// LOCAL PREP ONLY (row 69). Frozen multiword relevance for search.
// The route (src/app/api/jobs/search/route.ts, owned by #897 right now) fetches the 200 newest matching rows for a
// multi-word query, sorts them in JS by computeRelevance then time, and slices by page, re-fetching on every page, so
// pages drift. Here the SAME ordering is applied once to the first page's 200 rows and the ordered ids are frozen;
// later pages replay by id (snapshotReplay). rankMultiword below is a VERBATIM copy of the route's inline ranking
// (source-compared in the test); after #897 merges the route should import it instead of keeping its own copy.
import { captureOrder, type Snapshot } from "./snapshotReplay";

/** Rows the route fetches for a multi-word query (route: `.order("posted_at", desc nulls last).limit(200)`). */
export const MULTIWORD_POOL_LIMIT = 200;

type RelevanceRow = { id: string; title?: string | null; company?: string | null; category?: string | null; description?: string | null; posted_at?: string | null; created_at?: string | null };

/** The route's ordering, unchanged: relevance desc, then (posted_at || created_at || 0) desc; Array#sort is stable. */
export function rankMultiword<T extends RelevanceRow>(rows: readonly T[], cleanQuery: string): T[] {
  const sorted = rows.slice();
        const lowerQuery = cleanQuery.toLowerCase();
        const parts = lowerQuery.split(" ").filter(Boolean);

        const computeRelevance = (row: any): number => {
          let score = 0;
          const lowerTitle = (row.title || "").toLowerCase();
          const lowerCompany = (row.company || "").toLowerCase();
          const lowerCategory = (row.category || "").toLowerCase();
          const lowerDesc = (row.description || "").toLowerCase();

          if (lowerTitle.includes(lowerQuery)) score += 100;
          else if (lowerCompany.includes(lowerQuery)) score += 80;

          let titleTokens = 0;
          let descTokens = 0;
          for (const p of parts) {
            if (lowerTitle.includes(p)) titleTokens++;
            if (lowerDesc.includes(p)) descTokens++;
          }
          score += titleTokens * 25;
          score += descTokens * 5;

          if (lowerCategory.includes(lowerQuery)) score += 15;
          return score;
        };

        sorted.sort((a: any, b: any) => {
          const relA = computeRelevance(a);
          const relB = computeRelevance(b);
          if (relB !== relA) return relB - relA;
          const timeA = new Date(a.posted_at || a.created_at || 0).getTime();
          const timeB = new Date(b.posted_at || b.created_at || 0).getTime();
          return timeB - timeA;
        });
  return sorted;
}

/** Freeze the multiword order at the first page: exactly the ranked ids of the (at most 200) fetched rows. */
export function captureMultiword<T extends RelevanceRow>(fetchedRows: readonly T[], cleanQuery: string): Snapshot {
  if (fetchedRows.length > MULTIWORD_POOL_LIMIT) throw new RangeError(`multiword capture takes at most ${MULTIWORD_POOL_LIMIT} rows`);
  return captureOrder(rankMultiword(fetchedRows, cleanQuery), MULTIWORD_POOL_LIMIT);
}
