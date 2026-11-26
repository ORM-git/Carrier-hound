/**
 * scripts/repair-company-logos.ts — bounded, idempotent company-logo repair (ingest follow-up, scheduled
 * sweep and reviewed backfill). Applies the single logo contract in src/lib/companies/logoRepair.ts.
 *
 *   Dry run (default, read-only):  npx tsx scripts/repair-company-logos.ts --limit 40
 *       Resolves candidates, uploads nothing, writes reports/logo-repair/manifest-<ts>.json (+ rollback SQL)
 *       and prints the scoped --write command for exactly those companies.
 *   Write (needs migrations 20261122_company_logo_contract + 20261123_company_logo_review_state + approval):
 *       npx tsx scripts/repair-company-logos.ts --write --limit 40 --trigger sweep
 *       npx tsx scripts/repair-company-logos.ts --write --trigger backfill --limit 40 --concurrency 4 --verify 0 --manifest reports/logo-repair/manifest-....json
 *
 * Owner review state (company_logo_reviews / company_logo_rejected_hashes) is honoured everywhere: held and
 * keep-initials companies are never claimed, previewed or verified, and an owner-rejected image hash is never
 * selected again whichever source returns it. A manifest run touches only its listed companies (--verify 0).
 * Caps are explicit and bounded: --limit 1..200 is REQUIRED (never empty/unlimited), --concurrency 1..8,
 * --verify 0..100 hosted logos re-checked per run (default 25 for sweeps; manifest runs must use 0). Companies are leased via claim_company_logo_batch
 * (FOR UPDATE SKIP LOCKED), so TS ingest follow-ups, Python-enqueued work and sweeps never collide.
 * Exit codes: 0 ok, 1 run error, 2 usage/migration missing, 3 alert (stalled previous run or rising backlog).
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { COMPANY_LOGO_BUCKET, classifyLogoUrl, eligibleLogoUrl, logoObjectKey, logoProjectOrigin } from "../src/lib/companies/logoEligibility";
import { fetchWithTimeout, resolveCompanyLogo, type JobUrlInfo, type ResolvedLogoResult } from "../src/lib/companies/logoResolver";
import { candidateRejection, KNOWN_VENDOR_DEFAULT_SHA256, repairCompanyLogo, sha256Hex, verifyHostedLogo, type ClaimedCompany, type LogoRepairDeps, type RepairOutcome } from "../src/lib/companies/logoRepair";

export type Trigger = "ingest-ts" | "ingest-python" | "sweep" | "backfill";
export interface RepairArgs { write: boolean; limit: number; concurrency: number; verify: number; leaseSeconds: number; trigger: Trigger; manifest: string | null; outDir: string }

export function parseArgs(argv: string[]): RepairArgs {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  const int = (flag: string, raw: string | undefined, min: number, max: number, dflt?: number) => {
    if (raw === undefined) {
      if (dflt === undefined) throw new Error(`${flag} is required (${min}..${max}); there is no unlimited mode`);
      return dflt;
    }
    if (!/^\d+$/.test(raw)) throw new Error(`${flag} must be an integer ${min}..${max} (got "${raw}")`);
    const n = Number(raw);
    if (n < min || n > max) throw new Error(`${flag} must be ${min}..${max} (got ${n})`);
    return n;
  };
  const known = new Set(["--write", "--limit", "--concurrency", "--verify", "--lease-seconds", "--trigger", "--manifest", "--out"]);
  for (const a of argv) if (a.startsWith("--") && !known.has(a)) throw new Error(`unknown flag ${a}`);
  const trigger = (get("--trigger") ?? "sweep") as Trigger;
  if (!["ingest-ts", "ingest-python", "sweep", "backfill"].includes(trigger)) throw new Error(`--trigger must be ingest-ts|ingest-python|sweep|backfill`);
  const write = argv.includes("--write");
  const manifest = get("--manifest") ?? null;
  if (trigger === "backfill" && write && !manifest) throw new Error("--trigger backfill --write requires --manifest <reviewed manifest>");
  const verify = int("--verify", get("--verify"), 0, 100, manifest ? 0 : 25);
  // The verification pass is unscoped: it would touch companies outside the reviewed manifest.
  if (manifest && verify !== 0) throw new Error("--manifest runs must use --verify 0 (verification would touch companies outside the manifest)");
  return {
    write,
    limit: int("--limit", get("--limit"), 1, 200),
    concurrency: int("--concurrency", get("--concurrency"), 1, 8, 4),
    verify,
    leaseSeconds: int("--lease-seconds", get("--lease-seconds"), 60, 3600, 900),
    trigger,
    manifest,
    outDir: get("--out") ?? "reports/logo-repair",
  };
}

type Coverage = { companies_with_active_jobs: number; eligible_hosted: number; missing_or_ineligible: number; held?: number; intentional_initials?: number; approved?: number; pending?: number; failed?: number; missing?: number; queued_retries?: number; orphan_links: number };

/** Companies the owner put on hold or keep-initials (20261123), or null before that migration exists. */
async function blockedCompanyIds(sb: SupabaseClient): Promise<Set<string> | null> {
  const { data, error } = await sb.from("company_logo_reviews").select("company_id").is("cleared_at", null).in("decision", ["hold", "initials"]);
  if (error) {
    if (/PGRST205|42P01|does not exist|Could not find the table/i.test(`${error.code} ${error.message}`)) return null;
    throw new Error(`review state read failed: ${error.message}`);
  }
  return new Set((data || []).map((r: any) => r.company_id));
}

async function hasMigration(sb: SupabaseClient, origin: string): Promise<boolean> {
  const { error } = await sb.rpc("company_logo_coverage", { p_origin: origin });
  if (!error) return true;
  if (/PGRST202|42883|Could not find the function|does not exist/i.test(`${error.code} ${error.message}`)) return false;
  throw new Error(`coverage probe failed: ${error.message}`);
}

/** Read-only coverage without the migration (used for dry runs before it is applied). */
async function coverageReadOnly(sb: SupabaseClient, supabaseUrl: string): Promise<{ coverage: Coverage; live: Map<string, number> }> {
  const live = new Map<string, number>();
  let orphan = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("jobs").select("company_id").eq("status", "active").eq("is_active", true).order("id").range(from, from + 999);
    if (error) throw new Error(`jobs read failed: ${error.message}`);
    for (const j of data) j.company_id ? live.set(j.company_id, (live.get(j.company_id) || 0) + 1) : orphan++;
    if (data.length < 1000) break;
  }
  const rows: { id: string; logo_url: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("companies").select("id,logo_url").order("id").range(from, from + 999);
    if (error) throw new Error(`companies read failed: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const ids = new Set(rows.map((r) => r.id));
  for (const id of Array.from(live.keys())) if (!ids.has(id)) { orphan += live.get(id)!; live.delete(id); }
  const lc = rows.filter((r) => live.has(r.id));
  const hosted = lc.filter((r) => eligibleLogoUrl(r.logo_url, supabaseUrl)).length;
  return { live, coverage: { companies_with_active_jobs: lc.length, eligible_hosted: hosted, missing_or_ineligible: lc.length - hosted, orphan_links: orphan } };
}

async function knownDefaultHashes(): Promise<Set<string>> {
  // Favicon services answer unknown domains with a generic image; its bytes must never become a company logo.
  const out = new Set<string>();
  for (const u of ["https://www.google.com/s2/favicons?domain=careermonke-default-probe.invalid&sz=128", "https://icons.duckduckgo.com/ip3/careermonke-default-probe.invalid.ico"]) {
    try {
      const r = await fetchWithTimeout(u);
      if (r.ok) out.add(sha256Hex(Buffer.from(await r.arrayBuffer())));
    } catch { /* probe is best-effort; the shared-hash rule still applies */ }
  }
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

export function buildDeps(sb: SupabaseClient, supabaseUrl: string, defaults: Set<string>, write: boolean, previewDir: string | null = null): LogoRepairDeps {
  const bucket = sb.storage.from(COMPANY_LOGO_BUCKET);
  const conditional = (q: any, id: string, token: string, expected: string | null) => {
    q = q.eq("id", id).eq("logo_claim_token", token);
    return expected == null ? q.is("logo_url", null) : q.eq("logo_url", expected);
  };
  return {
    supabaseUrl,
    resolve: resolveCompanyLogo,
    async jobsFor(companyId) {
      const { data } = await sb.from("jobs").select("apply_url,source_url").eq("company_id", companyId).eq("status", "active").eq("is_active", true).limit(5);
      return (data || []) as JobUrlInfo[];
    },
    knownDefaultHashes: defaults,
    async rejectedHashes(companyId) {
      const { data, error } = await sb.from("company_logo_rejected_hashes").select("sha256").eq("company_id", companyId).is("cleared_at", null);
      // A write never proceeds blind (the commit trigger would refuse a rejected image anyway).
      if (error) { if (write) throw new Error(`rejected-hash read failed: ${error.message}`); return new Set<string>(); }
      return new Set<string>((data || []).map((r: any) => r.sha256));
    },
    async companiesSharingHash(sha, excludeId) {
      const { count, error } = await sb.from("companies").select("id", { count: "exact", head: true }).eq("logo_hash", sha).neq("id", excludeId);
      // Never silently disable the identity guard. A pre-migration preview must report the
      // missing check too, rather than presenting an unchecked candidate as safe to host.
      if (error) throw new Error(`shared-hash check unavailable (${write ? "write" : "dry-run"}): ${error.message}`);
      return count || 0;
    },
    async upload(key, bytes, contentType) {
      if (!write) {
        // Dry run: keep the exact bytes that would be uploaded, for the reviewed manifest's contact sheet.
        if (previewDir) {
          const p = path.join(previewDir, key);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, bytes);
        }
        return "created";
      }
      const { error } = await bucket.upload(key, bytes, { contentType, upsert: false, cacheControl: "31536000" });
      if (!error) return "created";
      if (/exists|duplicate|409/i.test(`${(error as any).statusCode ?? ""} ${error.message}`)) return "exists";
      throw new Error(error.message);
    },
    async commitHosted(a) {
      if (!write) return true;
      const patch: Record<string, unknown> = {
        logo_url: a.logoUrl, logo_status: "hosted", logo_source: a.source, logo_hash: a.sha256, logo_failure_reason: null,
        logo_attempts: 0, logo_last_attempt_at: a.at.toISOString(), logo_next_attempt_at: null, logo_verified_at: a.at.toISOString(),
        logo_claimed_until: null, logo_claim_token: null,
      };
      const { data: cur } = await sb.from("companies").select("domain").eq("id", a.id).maybeSingle();
      if (a.domain && !cur?.domain) patch.domain = a.domain; // persist the verified domain, never overwrite one
      let update = conditional(sb.from("companies").update(patch), a.id, a.token, a.expectedLogoUrl);
      // Do not overwrite a domain that another enrichment writer set after the read above.
      if (patch.domain) update = update.is("domain", null);
      const { data, error } = await update.select("id");
      if (error) throw new Error(error.message);
      return (data || []).length === 1;
    },
    async recordFailure(a) {
      if (!write) return true;
      const patch: Record<string, unknown> = {
        logo_status: a.status, logo_failure_reason: a.reason, logo_attempts: a.attempts, logo_last_attempt_at: a.at.toISOString(),
        logo_next_attempt_at: a.nextAttemptAt?.toISOString() ?? null, logo_claimed_until: null, logo_claim_token: null,
        ...(a.clearLogoUrl ? { logo_url: null } : {}),
      };
      const { data, error } = await conditional(sb.from("companies").update(patch), a.id, a.token, a.expectedLogoUrl).select("id");
      if (error) throw new Error(error.message);
      return (data || []).length === 1;
    },
    async markAlreadyEligible(a) {
      if (!write) return;
      await sb.from("companies").update({ logo_status: "hosted", logo_claimed_until: null, logo_claim_token: null, logo_verified_at: a.at.toISOString() }).eq("id", a.id).eq("logo_claim_token", a.token);
    },
    now: () => new Date(),
  };
}

/** The reviewed write for a dry-run manifest: always manifest-scoped, bounded, and with no verification pass. */
export function reviewedWriteCommand(count: number, concurrency: number, manifestPath: string): string {
  return `npx tsx scripts/repair-company-logos.ts --write --trigger backfill --limit ${Math.max(1, count)} --concurrency ${concurrency} --verify 0 --manifest ${manifestPath}`;
}

function sqlLit(v: string | null) {
  return v == null ? "NULL" : `'${v.replace(/'/g, "''")}'`;
}

export function rollbackSql(outcomes: RepairOutcome[]): string {
  // Run-scoped: restores each committed row's previous logo_url only if it still holds this run's value and the
  // owner has not since put it under review, so later legitimate changes are never overwritten.
  const lines = outcomes.filter((o) => o.status === "repaired" || (o.status !== "already-eligible" && o.previousLogoUrl))
    .map((o) => `UPDATE public.companies SET logo_url = ${sqlLit(o.previousLogoUrl)}, logo_status = NULL WHERE id = '${o.id}' AND logo_url IS NOT DISTINCT FROM ${sqlLit(o.status === "repaired" ? o.logoUrl : null)} AND NOT public.company_logo_blocked('${o.id}');`);
  return ["-- Scoped rollback for this run. Storage objects are versioned and never deleted, so old URLs stay valid.", "BEGIN;", ...lines, "COMMIT;", ""].join("\n");
}

async function main() {
  let args: RepairArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`usage error: ${(e as Error).message}`);
    process.exit(2);
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !key) { console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(2); }
  const sb = createClient(supabaseUrl, key, { auth: { persistSession: false } });
  const origin = logoProjectOrigin(supabaseUrl)!;
  const startedAt = new Date();
  const migrated = await hasMigration(sb, origin);
  if (args.write && !migrated) { console.error("::error::migration 20261122_company_logo_contract is not applied; --write refused"); process.exit(2); }
  const blocked = await blockedCompanyIds(sb);
  if (args.write && !blocked) { console.error("::error::migration 20261123_company_logo_review_state is not applied; --write refused (owner holds/rejections must be enforced)"); process.exit(2); }
  const isBlocked = (id: string) => blocked?.has(id) ?? false;

  const alerts: string[] = [];
  let runId: number | null = null;
  let prevRuns: any[] = [];
  if (args.write) {
    const { data: prev } = await sb.from("company_logo_runs").select("id,started_at,finished_at,missing_or_ineligible,repaired,details").order("started_at", { ascending: false }).limit(4);
    prevRuns = (prev || []).filter((r: any) => r.finished_at);
    const unfinished = (prev || []).find((r: any) => !r.finished_at && Date.now() - Date.parse(r.started_at) > 3600_000);
    if (unfinished) alerts.push(`stalled: run ${unfinished.id} started ${unfinished.started_at} never finished`);
    const backlog = (prev || []).filter((r: any) => r.finished_at).map((r: any) => r.missing_or_ineligible).slice(0, 3);
    if (backlog.length === 3 && backlog[0] > backlog[1] && backlog[1] > backlog[2]) alerts.push(`rising backlog: missing/ineligible ${backlog.reverse().join(" -> ")} over the last 3 runs`);
    const { data: run, error } = await sb.from("company_logo_runs").insert({ trigger: args.trigger, cap: args.limit }).select("id").single();
    if (error) throw new Error(`run log insert failed: ${error.message}`);
    runId = run.id;
  }

  const before = migrated ? ((await sb.rpc("company_logo_coverage", { p_origin: origin })).data as Coverage) : (await coverageReadOnly(sb, supabaseUrl)).coverage;
  const defaults = await knownDefaultHashes();
  for (const h of KNOWN_VENDOR_DEFAULT_SHA256) defaults.add(h);
  const deps = buildDeps(sb, supabaseUrl, defaults, args.write, args.write ? null : path.join(args.outDir, "preview"));

  // Manifest (reviewed backfill): exact ids + the logo_url each was reviewed with.
  // Each entry also carries the reviewed outcome: the exact image hash to host, or null (no logo / initials).
  let manifest: { id: string; expected_logo_url: string | null; expected_sha256: string | null }[] | null = null;
  if (args.manifest) {
    const m = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
    manifest = (m.companies || []).map((c: any) => ({ id: c.id, expected_logo_url: c.current_logo_url ?? null, expected_sha256: c.plan?.action === "host" ? c.plan.sha256 ?? null : null }));
    if (!manifest!.length) throw new Error("manifest has no companies");
    if (manifest!.length > args.limit) throw new Error(`manifest has ${manifest!.length} companies, above --limit ${args.limit}`);
  }

  // Candidates: leased (write) or read-only preview (dry run).
  let claimed: ClaimedCompany[] = [];
  if (args.write) {
    const { data, error } = await sb.rpc("claim_company_logo_batch", { p_limit: args.limit, p_origin: origin, p_lease_seconds: args.leaseSeconds, p_ids: manifest ? manifest.map((m) => m.id) : null });
    if (error) throw new Error(`claim failed: ${error.message}`);
    claimed = (data || []).map((r: any) => ({ ...r, logo_attempts: r.logo_attempts ?? 0 }));
    if (manifest) {
      const exp = new Map(manifest.map((m) => [m.id, m.expected_logo_url]));
      const drift = claimed.filter((c) => (exp.get(c.id) ?? null) !== (c.logo_url ?? null));
      for (const c of drift) {
        alerts.push(`manifest drift: ${c.id} logo_url changed since review; skipped`);
        await sb.from("companies").update({ logo_claimed_until: null, logo_claim_token: null }).eq("id", c.id).eq("logo_claim_token", c.claim_token);
      }
      claimed = claimed.filter((c) => !drift.includes(c));
    }
  } else {
    const { live } = migrated ? { live: null as Map<string, number> | null } : await coverageReadOnly(sb, supabaseUrl);
    const { data } = await sb.from("companies").select("id,name,slug,domain,careers_url,ats_type,logo_url").order("id").limit(5000);
    let rows = ((data || []) as any[]).filter((r) => !isBlocked(r.id)); // same rule as claim_company_logo_batch
    if (manifest) rows = rows.filter((r) => manifest!.some((m) => m.id === r.id));
    else rows = rows.filter((r) => !eligibleLogoUrl(r.logo_url, supabaseUrl) && (!live || live.has(r.id)));
    if (live) rows.sort((a, b) => (live.get(b.id) || 0) - (live.get(a.id) || 0));
    claimed = rows.slice(0, args.limit).map((r) => ({ ...r, logo_attempts: 0, claim_token: "dry-run" }));
  }

  // Pre-pass: resolve the whole batch first. An image that resolves for 2+ companies is a vendor/default
  // mark (e.g. an ATS board's own logo), so it is rejected and those companies are re-resolved (next tier).
  const pre = new Map<string, { r: ResolvedLogoResult | null } | { e: unknown }>();
  const runDefaults: string[] = [];
  let todo = claimed;
  for (let round = 0; round < 3 && todo.length; round++) {
    await pool(todo, args.concurrency, async (c) => {
      try {
        const jobs = await deps.jobsFor(c.id);
        const rejected = await deps.rejectedHashes(c.id);
        const r = await resolveCompanyLogo({ ...c, logo_url: null }, jobs, { isRejected: async (b) => (await candidateRejection(b, defaults, rejected)) !== null });
        pre.set(c.id, { r });
      } catch (e) {
        pre.set(c.id, { e });
      }
    });
    const owners = new Map<string, string[]>();
    for (const c of claimed) {
      const p = pre.get(c.id);
      if (p && "r" in p && p.r) {
        const h = sha256Hex(p.r.buffer);
        owners.set(h, [...(owners.get(h) || []), c.id]);
      }
    }
    const dupes = Array.from(owners.entries()).filter(([, v]) => v.length > 1);
    for (const [h] of dupes) { defaults.add(h); runDefaults.push(h); }
    const again = new Set(dupes.flatMap(([, v]) => v));
    todo = claimed.filter((c) => again.has(c.id));
  }
  // A reviewed write hosts exactly the reviewed image (or nothing): any different outcome is drift, skipped.
  if (manifest) {
    const want = new Map(manifest.map((m) => [m.id, m.expected_sha256]));
    const drifted = claimed.filter((c) => {
      const p = pre.get(c.id);
      const got = p && "r" in p && p.r ? sha256Hex(p.r.buffer) : null;
      return got !== (want.get(c.id) ?? null);
    });
    for (const c of drifted) {
      alerts.push(`manifest drift: ${c.id} ${c.name} resolves to a different image than reviewed; skipped, needs re-review`);
      if (args.write) await sb.from("companies").update({ logo_claimed_until: null, logo_claim_token: null }).eq("id", c.id).eq("logo_claim_token", c.claim_token);
    }
    claimed = claimed.filter((c) => !drifted.includes(c));
  }
  const batchDeps: LogoRepairDeps = {
    ...deps,
    async resolve(company) {
      const p = pre.get(company.id);
      if (!p) return null;
      if ("e" in p) throw p.e;
      return p.r;
    },
  };

  const outcomes = await pool(claimed, args.concurrency, async (c) => {
    try {
      return await repairCompanyLogo(c, batchDeps);
    } catch (e) {
      // Release the lease so the next run can retry; never block ingestion on branding.
      if (args.write) await sb.from("companies").update({ logo_claimed_until: null, logo_claim_token: null }).eq("id", c.id).eq("logo_claim_token", c.claim_token);
      return { id: c.id, name: c.name, status: "failed", reason: `worker-error: ${String((e as Error)?.message || e).slice(0, 160)}`, source: null, logoUrl: null, previousLogoUrl: c.logo_url, sha256: null, attempts: c.logo_attempts, nextAttemptAt: null } as RepairOutcome;
    }
  });

  // Verified-broken check: re-test the least recently verified hosted logos of live companies.
  const broken: { id: string; name: string; logo_url: string; status: string }[] = [];
  if (args.verify > 0) {
    let q = sb.from("companies").select("id,name,logo_url").like("logo_url", `${origin}/storage/v1/object/public/${COMPANY_LOGO_BUCKET}/%`).limit(args.verify);
    if (migrated) q = q.order("logo_verified_at", { ascending: true, nullsFirst: true });
    const { data } = await q;
    // Only this project's eligible URLs are fetched, through the resolver's safe fetcher (DNS/private-IP and
    // redirect checks, timeout, size cap); a logo is broken only if it fails to download AND decode twice.
    const candidates = ((data || []) as any[]).filter((c) => eligibleLogoUrl(c.logo_url, supabaseUrl) && !isBlocked(c.id));
    await pool(candidates, args.concurrency, async (c) => {
      let status = await verifyHostedLogo(c.logo_url, supabaseUrl);
      if (status !== "ok") status = await verifyHostedLogo(c.logo_url, supabaseUrl); // one retry: transient blips are not "broken"
      if (status !== "ok") broken.push({ ...c, status });
      if (args.write && migrated) {
        await sb.from("companies").update(status === "ok" ? { logo_verified_at: new Date().toISOString() } : { logo_status: "pending", logo_failure_reason: `hosted-broken: ${status}`, logo_next_attempt_at: new Date().toISOString() }).eq("id", c.id).eq("logo_url", c.logo_url);
      }
    });
  }

  const after = migrated ? ((await sb.rpc("company_logo_coverage", { p_origin: origin })).data as Coverage) : before;
  const count = (s: string) => outcomes.filter((o) => o.status === s).length;
  const summary = {
    trigger: args.trigger, mode: args.write ? "write" : "dry-run", migrationApplied: migrated, cap: args.limit, concurrency: args.concurrency,
    startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
    counts: {
      companies_with_active_jobs: after.companies_with_active_jobs,
      eligible_hosted: after.eligible_hosted,
      intentional_initials: after.intentional_initials ?? 0,
      held: after.held ?? blocked?.size ?? 0,
      pending: after.pending ?? 0,
      failed: after.failed ?? 0,
      missing_or_ineligible: after.missing_or_ineligible,
      failed_resolutions_or_uploads: count("failed"),
      no_logo_available: count("missing"),
      repaired_this_run: count("repaired"),
      already_eligible: count("already-eligible"),
      queued_retries: after.queued_retries ?? outcomes.filter((o) => o.nextAttemptAt).length,
      orphan_company_links: after.orphan_links,
      hosted_verified: args.verify, hosted_broken: broken.length,
    },
    coverageBefore: before,
    affected: outcomes.filter((o) => o.status !== "already-eligible").map((o) => ({ id: o.id, name: o.name, status: o.status, reason: o.reason, source: o.source, logo_url: o.logoUrl, previous_logo_url: o.previousLogoUrl, next_attempt_at: o.nextAttemptAt })),
    brokenHosted: broken,
    vendorDefaultImagesRejectedThisRun: runDefaults,
    alerts,
  };

  fs.mkdirSync(args.outDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(args.outDir, `summary-${stamp}.json`), JSON.stringify(summary, null, 2));
  if (!args.write) {
    const manifestOut = {
      reviewedAt: null, generatedAt: summary.finishedAt, cap: args.limit,
      companies: outcomes.map((o) => ({
        id: o.id, name: o.name, current_logo_url: o.previousLogoUrl, current_class: classifyLogoUrl(o.previousLogoUrl, supabaseUrl),
        plan: o.status === "repaired" ? { action: "host", source: o.source, sha256: o.sha256, key: o.sha256 ? logoObjectKey(o.id, o.sha256, (o.logoUrl || "").split(".").pop() || "png") : null, hosted_url: o.logoUrl }
          : o.status === "already-eligible" ? { action: "none" }
          : { action: o.previousLogoUrl ? "clear-external-to-initials" : "keep-initials", reason: o.reason },
      })),
    };
    const mf = path.join(args.outDir, `manifest-${stamp}.json`);
    fs.writeFileSync(mf, JSON.stringify(manifestOut, null, 2));
    fs.writeFileSync(path.join(args.outDir, `rollback-${stamp}.sql`), rollbackSql(outcomes));
    console.log(`\nReviewed write command (exactly these ${outcomes.length} companies):\n  ${reviewedWriteCommand(outcomes.length, args.concurrency, mf)}`);
  } else {
    fs.writeFileSync(path.join(args.outDir, `rollback-${stamp}.sql`), rollbackSql(outcomes));
  }

  const md = [
    `### Company logo repair (${summary.trigger}, ${summary.mode})`,
    "", "| metric | count |", "|---|---|",
    ...Object.entries(summary.counts).map(([k, v]) => `| ${k} | ${v} |`),
    "", alerts.length ? `**Alerts:** ${alerts.join("; ")}` : "No alerts.",
    "", "<details><summary>Affected companies</summary>", "",
    ...summary.affected.map((a) => `- \`${a.id}\` ${a.name}: ${a.status}${a.reason ? ` (${a.reason})` : ""}`),
    "</details>",
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  console.log(JSON.stringify(summary.counts));

  // Infrastructure failures alert (exit 1); a company whose logo is simply unavailable does not.
  const infra = outcomes.filter((o) => /^(worker-error|upload-failed|db-update-failed|resolver-error|shared-hash-check-error)/.test(o.reason || ""));
  let runError = infra.length > 0;
  if (runError) alerts.push(`${infra.length} infrastructure failure(s): ${infra.slice(0, 5).map((o) => `${o.id} ${o.reason}`).join("; ")}`);
  // No progress: due work exists but nothing was repaired in this run and the previous two.
  const pendingNow = Number((after as Coverage).pending ?? 0);
  const idle = (r: any) => Number(r?.details?.pending ?? 0) > 0 && Number(r?.repaired ?? 0) === 0;
  if (pendingNow > 0 && count("repaired") === 0 && prevRuns.length >= 2 && prevRuns.slice(0, 2).every(idle)) {
    alerts.push(`no progress: ${pendingNow} companies pending and nothing repaired in the last 3 runs`);
  }
  if (args.write && runId != null) {
    const { error: logError } = await sb.from("company_logo_runs").update({
      finished_at: summary.finishedAt, ok: !runError, companies_with_active_jobs: summary.counts.companies_with_active_jobs,
      eligible_hosted: summary.counts.eligible_hosted, missing_or_ineligible: summary.counts.missing_or_ineligible,
      failed: summary.counts.failed_resolutions_or_uploads, repaired: summary.counts.repaired_this_run,
      queued_retries: summary.counts.queued_retries, orphan_links: summary.counts.orphan_company_links,
      details: { affected: summary.affected.slice(0, 200), brokenHosted: broken, alerts, pending: pendingNow },
    }).eq("id", runId);
    if (logError) { runError = true; console.log(`::error title=Company logo repair::run log update failed: ${logError.message}`); }
  }
  for (const a of alerts) console.log(`::error title=Company logo repair alert::${a}`);
  process.exit(runError ? 1 : alerts.length ? 3 : 0);
}

if (process.argv[1] && /repair-company-logos\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`::error title=Company logo repair failed::${(e as Error).message}`);
    process.exit(1);
  });
}
