/**
 * Read-only Step D pre-canary report: what Wikidata states for up to 3 companies, before any plan or write.
 * No database, no credentials: company names and domains come from an inventory JSON already made by
 * scripts/inventory-company-profiles.ts. The only network calls are public Wikidata Action API reads
 * (descriptive User-Agent, 1 request per second, no retry on 403/429). It never writes anything but --out.
 *
 *   npx tsx scripts/report-company-wikidata.ts --inventory ../canary/inventory-<DATE>.json[,more.json] \
 *     --company-ids <UUID>[,<UUID>[,<UUID>]] --out ../canary/wikidata-report-<DATE>.json
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeFetchWikidataJson } from "../src/lib/company-profile/safeFetch";
import { fetchWikidataProfile } from "../src/lib/company-profile/wikidata";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parse(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!["--inventory", "--company-ids", "--out"].includes(flag) || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete flag: ${flag}`);
    out[flag.slice(2)] = argv[i + 1];
  }
  const ids = String(out["company-ids"] || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!out.inventory || !out.out || !ids.length || ids.length > 3 || ids.some((id) => !UUID.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error("Need --inventory <json[,json]>, --out <file> and 1-3 distinct --company-ids UUIDs");
  }
  const outPath = path.resolve(out.out);
  if (outPath.startsWith(path.resolve(process.cwd()) + path.sep)) throw new Error("--out must be outside the repository");
  if (fs.existsSync(outPath)) throw new Error("--out file already exists; choose a new path");
  return { inventories: out.inventory.split(",").map((p) => path.resolve(p)), ids, outPath };
}

async function main() {
  const { inventories, ids, outPath } = parse(process.argv.slice(2));
  const known = new Map<string, { name: string; canonical_domain: string | null; active_jobs: number }>();
  for (const file of inventories) {
    const inv = JSON.parse(fs.readFileSync(file, "utf8")) as { kind?: string; companies?: Array<{ company_id: string; name: string; canonical_domain: string | null; active_jobs: number }> };
    for (const c of inv.companies || []) known.set(c.company_id.toLowerCase(), c);
  }
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) throw new Error(`Company IDs not in the inventory: ${missing.join(", ")}`);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const companies = [];
  for (const [index, id] of ids.entries()) {
    if (index) await sleep(1_000);
    const company = known.get(id)!;
    const sources: Array<Record<string, unknown>> = [];
    try {
      const profile = await fetchWikidataProfile({
        company, fetchJson: (url) => safeFetchWikidataJson(url), sleep, now: () => new Date().toISOString(),
        sha256: (t) => createHash("sha256").update(t).digest("hex"), record: (s) => sources.push(s),
      });
      companies.push({ company_id: id, name: company.name, canonical_domain: company.canonical_domain, active_jobs: company.active_jobs, ...profile, sources });
    } catch (error) {
      companies.push({ company_id: id, name: company.name, canonical_domain: company.canonical_domain, outcome: "fetch_failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 200), sources });
    }
  }
  const report = { kind: "company-wikidata-report", read_only: true, writes: 0, database: "not contacted", generated_at: new Date().toISOString(), companies };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ out: outPath, companies: companies.map((c: any) => ({ name: c.name, outcome: c.outcome, entity: c.entityId ?? null, facts: Object.keys(c.facts || {}), leaders: (c.leadership || []).map((l: any) => `${l.name} (${l.role})`) })) }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
