/**
 * Ingest-side half of the logo contract: mark companies whose logo is not an eligible hosted logo as
 * pending for scripts/repair-company-logos.ts. Fail-open (never throws) so branding can never block jobs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logoProjectOrigin } from "./logoEligibility";

export type EnqueueResult = { status: "ok"; enqueued: number; coverage: Record<string, number> | null } | { status: "not-migrated" } | { status: "error"; error: string };

const BATCH = 500;

export async function enqueueCompanyLogos(sb: SupabaseClient, ids: string[]): Promise<EnqueueResult> {
  const unique = Array.from(new Set(ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id))));
  const origin = logoProjectOrigin();
  if (!origin) return { status: "error", error: "NEXT_PUBLIC_SUPABASE_URL is not configured" };
  let enqueued = 0;
  try {
    for (let i = 0; i < unique.length; i += BATCH) {
      const { data, error } = await sb.rpc("enqueue_company_logos", { p_ids: unique.slice(i, i + BATCH), p_origin: origin });
      if (error) {
        if (/PGRST202|42883|Could not find the function|does not exist/i.test(`${error.code ?? ""} ${error.message}`)) return { status: "not-migrated" };
        return { status: "error", error: error.message };
      }
      enqueued += Number(data) || 0;
    }
    // Same counts as the sweep summary (coverage, pending/failed backlog, orphan links); null if unavailable.
    const { data: coverage } = await sb.rpc("company_logo_coverage", { p_origin: origin });
    return { status: "ok", enqueued, coverage: (coverage as Record<string, number>) ?? null };
  } catch (e) {
    return { status: "error", error: String((e as Error)?.message || e) };
  }
}

/** Board ingestion uses the same queue and worker. Never resolves or writes image URLs. */
export async function enqueueBoardCompanyLogo(
  sb: SupabaseClient,
  target: { id?: string; token: string; ats: string; company?: string },
): Promise<EnqueueResult | { status: "skipped" }> {
  try {
    const ats = target.ats.replace(/-board$/, "");
    const query = sb.from("companies").select("id,ats_type");
    const { data, error } = await (target.id ? query.eq("id", target.id) : query.eq("slug", target.token)).maybeSingle();
    if (error) return { status: "error", error: error.message };
    let company = data;
    if (company && company.ats_type !== ats) return { status: "skipped" };
    if (!company) {
      if (!target.company || target.id) return { status: "skipped" };
      const created = await sb.from("companies").insert({ name: target.company, slug: target.token, ats_type: ats, enabled: true }).select("id,ats_type").maybeSingle();
      if (created.error || !created.data) return { status: "error", error: created.error?.message || "company insert returned no row" };
      company = created.data;
    }
    return await enqueueCompanyLogos(sb, [company.id]);
  } catch (e) {
    return { status: "error", error: String((e as Error)?.message || e) };
  }
}
