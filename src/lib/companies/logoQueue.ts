/**
 * Ingest-side half of the logo contract: mark companies whose logo is not an eligible hosted logo as
 * pending for scripts/repair-company-logos.ts. Fail-open (never throws) so branding can never block jobs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type EnqueueResult = { status: "ok"; enqueued: number } | { status: "not-migrated" } | { status: "error"; error: string };

const BATCH = 500;

export async function enqueueCompanyLogos(sb: SupabaseClient, ids: string[]): Promise<EnqueueResult> {
  const unique = Array.from(new Set(ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id))));
  let enqueued = 0;
  try {
    for (let i = 0; i < unique.length; i += BATCH) {
      const { data, error } = await sb.rpc("enqueue_company_logos", { p_ids: unique.slice(i, i + BATCH) });
      if (error) {
        if (/PGRST202|42883|Could not find the function|does not exist/i.test(`${error.code ?? ""} ${error.message}`)) return { status: "not-migrated" };
        return { status: "error", error: error.message };
      }
      enqueued += Number(data) || 0;
    }
    return { status: "ok", enqueued };
  } catch (e) {
    return { status: "error", error: String((e as Error)?.message || e) };
  }
}
