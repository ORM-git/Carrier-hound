/**
 * Owner-run, read-only company inventory and candidate shortlist for the Company-tab canary.
 * Selects only; never fetches a company page; refuses every write or canary flag.
 *   npx tsx scripts/inventory-company-profiles.ts --limit 500 [--after-id <next_cursor>] [--shortlist 10] --out ../canary/inventory-<DATE>.json
 * See docs/company-profile-rollout.md.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { CANARY_TABLES, redactCanaryText } from "../src/lib/company-profile/canary";
import { buildCompanyInventory, parseInventoryOptions, renderInventorySummary, type InventoryStore } from "../src/lib/company-profile/inventory";

function supabaseInventoryStore(supabase: SupabaseClient): InventoryStore {
  const fail = (what: string, error: { message: string }) => { throw new Error(`${what} failed: ${error.message}`); };
  return {
    async companiesAfter(afterId, limit) {
      let query = supabase.from("companies").select("id,name,canonical_domain").order("id", { ascending: true }).limit(limit);
      if (afterId) query = query.gt("id", afterId);
      const { data, error } = await query;
      if (error) fail("Company inventory", error);
      return data || [];
    },
    async domainOwnerCounts(domains) {
      if (!domains.length) return {};
      // shortcut: exact (case-sensitive) match on the bare and www. forms; a mixed-case duplicate is not seen. Upgrade to an RPC with lower() if domains are not stored lower-case.
      const { data, error } = await supabase.from("companies").select("canonical_domain").in("canonical_domain", domains.flatMap((d) => [d, `www.${d}`]));
      if (error) fail("Domain ownership lookup", error);
      const counts: Record<string, number> = {};
      for (const row of data || []) { const d = String(row.canonical_domain).toLowerCase().replace(/^www\./, ""); counts[d] = (counts[d] || 0) + 1; }
      return counts;
    },
    async boards(companyIds) {
      const { data, error } = await supabase.from("company_boards").select("id,company_id,enabled,ats_type,slug,careers_url").in("company_id", companyIds);
      if (error) fail("ATS board lookup", error);
      return (data || []).map((b) => ({ ...b, enabled: b.enabled === true }));
    },
    async activeJobCounts(companyIds) {
      // One head-only count per company (at most 100 per page): exact counts without pulling job rows.
      const counts = await Promise.all(companyIds.map((id) => supabase.from("jobs").select("id", { count: "exact", head: true }).eq("company_id", id).eq("status", "active").eq("is_active", true)));
      return Object.fromEntries(companyIds.map((id, i) => {
        if (counts[i].error) fail("Active job count", counts[i].error!);
        return [id, counts[i].count || 0];
      }));
    },
    async rows(table, companyIds) {
      const { data, error } = await supabase.from(table).select(CANARY_TABLES[table].columns.join(",")).in("company_id", companyIds);
      if (error) fail(`${table} lookup`, error);
      return (data || []) as unknown as Record<string, unknown>[];
    },
  };
}

function gitHead(): { head: string | null; dirty: boolean; root: string | null } {
  try {
    const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { head: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain", "--untracked-files=no"]) !== "", root: git(["rev-parse", "--show-toplevel"]) };
  } catch { return { head: null, dirty: false, root: null }; }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";
  const secrets = [key, url];
  try {
    const options = parseInventoryOptions(process.argv.slice(2));
    if (!url || !key) throw new Error("Supabase service credentials are required (read-only use)");
    const out = path.resolve(options.out);
    const git = gitHead();
    if (git.root && !path.relative(path.resolve(git.root), out).startsWith("..")) throw new Error("--out must be outside the repository; owner inventories are not committed");
    if (fs.existsSync(out)) throw new Error("--out file already exists; choose a new path");
    const host = new URL(url).hostname;
    const target = host.endsWith(".supabase.co") ? host.split(".")[0] : host === "localhost" || host === "127.0.0.1" ? "local" : "custom-host";
    const report = await buildCompanyInventory({
      store: supabaseInventoryStore(createClient(url, key, { auth: { persistSession: false } })),
      afterId: options.afterId, limit: options.limit, shortlist: options.shortlist, now: () => new Date(),
      codeSha: git.head ? `${git.head}${git.dirty ? "+dirty" : ""}` : null, target, secrets,
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const summary = renderInventorySummary(report);
    if (secrets.some((s) => s && (json.includes(s) || summary.includes(s)))) throw new Error("Inventory contains a credential value; refusing to write it");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json, { flag: "wx" });
    fs.writeFileSync(out.replace(/\.json$/i, "") + ".summary.md", summary, { flag: "wx" });
    console.log(JSON.stringify({ mode: "inventory", read_only: true, writes: 0, crawled: false, out, next_cursor: report.window.next_cursor, counts: report.counts, shortlist: report.shortlist.map((s) => ({ rank: s.rank, company_id: s.company_id, name: s.name })) }, null, 2));
  } catch (error) {
    console.error(redactCanaryText(error instanceof Error ? error.message : String(error), secrets));
    process.exitCode = 1;
  }
}

main();
