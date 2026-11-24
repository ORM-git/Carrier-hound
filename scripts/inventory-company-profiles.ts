/**
 * Owner-run, read-only company inventory and candidate shortlist for the Company-tab canary.
 * Selects only; never fetches a company page; refuses every write or canary flag.
 * Every related read is paged until provably complete (src/lib/company-profile/inventoryStore.ts); an incomplete read stops the run with no output.
 *   npx tsx scripts/inventory-company-profiles.ts --limit 500 [--after-id <next_cursor>] [--shortlist 10] --out ../canary/inventory-<DATE>.json
 * See docs/company-profile-rollout.md.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { redactCanaryText } from "../src/lib/company-profile/canary";
import { buildCompanyInventory, parseInventoryOptions, renderInventorySummary } from "../src/lib/company-profile/inventory";
import { supabaseInventoryStore } from "../src/lib/company-profile/inventoryStore";

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
