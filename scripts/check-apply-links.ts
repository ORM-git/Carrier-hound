/**
 * CareerMonke read-only Apply-link TRANSPORT checker.
 *
 *   npx tsx scripts/check-apply-links.ts --fixture <file.json> [--seed <int>]   (fully offline)
 *   npx tsx scripts/check-apply-links.ts --db [--seed <int>]                    (opt-in, SELECT-only)
 *
 * "Reachable" means the final hop answered HTTP 2xx. It is not proof that the job is open,
 * that the page is the right posting, or that the company matches.
 *
 * Exit codes (see EXIT in scripts/lib/apply-link-checker.ts):
 *   0 all sampled links transport-reachable · 1 failed findings (404/410, other 4xx, unsafe URL,
 *   redirect loop/limit) · 2 no failures but indeterminate results (401/403/429/challenge, 5xx,
 *   timeout, transport error) · 3 not run / evidence unavailable. Nothing but 0 prints a reachable verdict.
 *
 * Fixture file: { "jobs": ApplyJob[], "dns": { host: address }, "responses": { "HEAD https://x/y": { "status": 200,
 *   "headers": { "location": "..." } } } }. Fixture mode never touches the network or the database.
 */

import * as fs from "fs";
import {
  checkJobs,
  exitCodeFor,
  sampleJobs,
  EXIT,
  OUTCOME,
  type ApplyJob,
  type CheckResult,
  type CheckerDeps,
  type FetchFn,
} from "./lib/apply-link-checker";

const SAMPLE_SIZE = 100;
// shortcut: DB universe is a bounded window ordered by id, not the whole table; widen only with a reviewed, indexed query.
const DB_WINDOW = 100;

interface Input {
  universe: ApplyJob[];
  universeLabel: string;
  deps: Pick<CheckerDeps, "fetch" | "lookup">;
}

class NotRun extends Error {}
function notRun(reason: string): never {
  throw new NotRun(reason);
}

function loadFixture(path: string): Input {
  let fx: {
    jobs?: ApplyJob[];
    dns?: Record<string, string>;
    responses?: Record<string, { status: number; headers?: Record<string, string> }>;
  };
  try {
    fx = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    notRun(`cannot read fixture ${path}: ${(e as Error).message}`);
  }
  if (!Array.isArray(fx.jobs)) notRun(`fixture ${path} has no "jobs" array`);
  const dns = fx.dns ?? {};
  const responses = fx.responses ?? {};
  const fetch: FetchFn = async (url, init) => {
    const r = responses[`${init.method} ${url}`];
    if (!r) throw new TypeError(`fixture has no response for ${init.method} ${url}`);
    return new Response(null, { status: r.status, headers: r.headers });
  };
  const lookup = async (host: string) => {
    if (!dns[host]) throw new Error(`fixture DNS: ENOTFOUND ${host}`);
    return [{ address: dns[host], family: dns[host].includes(":") ? 6 : 4 }];
  };
  return { universe: fx.jobs, universeLabel: `all ${fx.jobs.length} jobs in fixture ${path}`, deps: { fetch, lookup } };
}

async function loadDb(): Promise<Input> {
  const dotenv = await import("dotenv");
  dotenv.config({ path: ".env.local" });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) notRun("Supabase URL or key not configured.");
  const { createClient } = await import("@supabase/supabase-js");
  const { data, error } = await createClient(url, key)
    .from("jobs")
    .select("id, title, company, apply_url")
    .eq("status", "active")
    .not("apply_url", "is", null)
    .order("id")
    .limit(DB_WINDOW);
  if (error) notRun(`database query failed: ${error.message}`);
  const { fetch } = await import("undici");
  return {
    universe: (data ?? []) as ApplyJob[],
    universeLabel: `first ${DB_WINDOW} active jobs with apply_url ordered by id (bounded window, NOT a random sample of the table)`,
    deps: { fetch: fetch as unknown as FetchFn },
  };
}

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const seedRaw = get("--seed");
  const seed = seedRaw === undefined ? null : Number(seedRaw);
  if (seed !== null && !Number.isSafeInteger(seed)) notRun(`--seed must be an integer, got ${seedRaw}`);
  return { fixture: get("--fixture"), db: argv.includes("--db"), seed };
}

function printResult(r: CheckResult) {
  const chain = r.hops.map((h) => `${h.method} ${h.status ?? "-"} ${h.url}`).join(" -> ");
  console.log(`[${OUTCOME[r.category]}/${r.category}] ${r.company} - ${r.title}`);
  console.log(`    original: ${r.originalUrl}`);
  console.log(`    hops:     ${chain || "(no request sent)"}`);
  if (r.error) console.log(`    error:    ${r.error}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.fixture && args.db) notRun("choose one of --fixture or --db, not both.");
  if (!args.fixture && !args.db) notRun("no input mode. Pass --fixture <file.json> (offline) or --db (SELECT-only, opt-in).");
  const input = args.fixture ? loadFixture(args.fixture) : await loadDb();
  if (input.universe.length === 0) notRun("selection universe is empty.");

  const sample = sampleJobs(input.universe, SAMPLE_SIZE, args.seed);
  console.log("CAREERMONKE READ-ONLY APPLY-LINK TRANSPORT CHECK");
  console.log(`Universe:  ${input.universeLabel}`);
  console.log(
    args.seed === null
      ? `Sample:    first ${sample.length} of universe, in universe order (unseeded, not random)`
      : `Sample:    ${sample.length} of ${input.universe.length}, seeded shuffle, seed=${args.seed} (reproducible for the same universe)`,
  );
  console.log("");

  const results = await checkJobs(sample, {
    ...input.deps,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    onResult: (r) => {
      if (r.category !== "reachable") printResult(r);
    },
  });

  const counts = new Map<string, number>();
  for (const r of results) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  console.log("");
  console.log("Counts by category:");
  for (const [cat, n] of Array.from(counts).sort()) console.log(`  ${cat.padEnd(22)} ${String(n).padStart(4)}  (${OUTCOME[cat as CheckResult["category"]]})`);
  console.log(`  ${"total".padEnd(22)} ${String(results.length).padStart(4)}`);

  const code = exitCodeFor(results);
  const verdict = {
    [EXIT.ALL_REACHABLE]: "ALL REACHABLE (HTTP 2xx transport only; job openness and company match not verified)",
    [EXIT.FAILED_FINDINGS]: "FAILED FINDINGS present",
    [EXIT.INDETERMINATE]: "INDETERMINATE: no confirmed failures, but some links could not be judged",
    [EXIT.NOT_RUN]: "NOT RUN",
  }[code];
  console.log(`\nVerdict: ${verdict} (exit ${code})`);
  if (args.db) console.log("Read-only: one SELECT, no database writes.");
  process.exitCode = code; // no process.exit: lets stdout drain, and a leaked timer/socket would show as a hang
}

main().catch((err) => {
  if (err instanceof NotRun) {
    console.log(`NOT RUN: ${err.message}`);
    console.log("No links were checked. This is not a healthy verdict.");
  } else {
    console.error("Fatal error during apply-link check (NOT RUN):", err);
  }
  process.exitCode = EXIT.NOT_RUN;
});
