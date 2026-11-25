// Literal matching under production-equivalent semantics:
//  1. the REAL postgrest-js builder (what supabase-js sends) produces the request URL,
//  2. each filter is decoded the way PostgREST reads it (`[not.]op.value`, `or=(...)`; like-`*` is `%`),
//  3. REAL Postgres (PGlite) evaluates the operator (ILIKE, ~*) against stored names.
// So SQL wildcards (`_`, `%`), regex metacharacters and backslashes behave exactly as in production.
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PostgrestClient } from "@supabase/postgrest-js";
import { applyFeedConstraints, normalizeFeedConstraints } from "../feedConstraints";

const COMPANIES = [
  "O'Reilly Media", "OZReilly Media", "Under_score Co", "UnderXscore Co", "100% Hiring", "1000 Hiring", "Acme, Inc. (US)",
  "Acme Inc US", "Back\\slash Labs", "Backslash Labs", "ACME", "Acme", "Globex", "Meta", "Metabase", "Société Générale", "C++ Shop", "C Shop",
];
const TITLES = [
  "C++ Engineer", "CC Engineer", "50% Remote Analyst", "500 Analyst", "Data_Engineer", "DataXEngineer", "Lead (Platform)", "Lead Platform",
  "Path\\Finder", "PathFinder", "Sales Engineer", "Wholesale Buyer",
];

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec("create table jobs (id serial primary key, title text not null, company text not null)");
  let i = 0;
  for (const c of COMPANIES) await db.query("insert into jobs (title, company) values ($1, $2)", [`Role ${i++}`, c]);
  for (const t of TITLES) await db.query("insert into jobs (title, company) values ($1, $2)", [t, "Neutral Co"]);
});

const OPS: Record<string, string> = { eq: "=", ilike: "ILIKE", like: "LIKE", imatch: "~*", match: "~" };

/** One PostgREST condition `col.[not.]op.value` (or a query-string pair) to SQL with a bound parameter. */
function condition(col: string, expr: string, params: unknown[]): string {
  let neg = false;
  if (expr.startsWith("not.")) {
    neg = true;
    expr = expr.slice(4);
  }
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  let value = expr.slice(dot + 1);
  if (!(op in OPS)) throw new Error(`operator not modelled: ${op}`);
  if (op === "ilike" || op === "like") value = value.replace(/\*/g, "%"); // PostgREST: * is the like wildcard
  params.push(value);
  const sql = `${col} ${OPS[op]} $${params.length}`;
  return neg ? `NOT (${sql})` : sql;
}

/** Splits an unquoted `or=(a,b)` logic tree on top-level commas (enough for flat trees). */
function orTree(v: string, params: unknown[]): string {
  const inner = v.replace(/^\(|\)$/g, "");
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return "(" + parts.map((p) => { const d = p.indexOf("."); return condition(p.slice(0, d), p.slice(d + 1), params); }).join(" OR ") + ")";
}

async function run(input: Parameters<typeof normalizeFeedConstraints>[0]) {
  const builder: any = new PostgrestClient("http://postgrest.test").from("jobs").select("id, title, company");
  const q = applyFeedConstraints(builder, normalizeFeedConstraints(input));
  const url = new URL((q as any).url.toString());
  const params: unknown[] = [];
  const where: string[] = [];
  url.searchParams.forEach((v, k) => {
    if (k !== "select") where.push(k === "or" ? orTree(v, params) : condition(k, v, params));
  });
  const r = await db.query<{ title: string; company: string }>(
    `select title, company from jobs ${where.length ? "where " + where.join(" AND ") : ""} order by id`,
    params
  );
  return { companies: r.rows.map((x) => x.company), titles: r.rows.map((x) => x.title) };
}
const missing = (all: string[], kept: string[]) => all.filter((c) => !kept.includes(c));

describe("company include/exclude is an exact, case-insensitive, literal match", () => {
  it.each([
    ["O'Reilly Media", ["O'Reilly Media"]],
    ["Under_score Co", ["Under_score Co"]],
    ["100% Hiring", ["100% Hiring"]],
    ["Acme, Inc. (US)", ["Acme, Inc. (US)"]],
    ["Back\\slash Labs", ["Back\\slash Labs"]],
    ["c++ shop", ["C++ Shop"]],
    ["acme", ["ACME", "Acme"]],
    ["Meta", ["Meta"]],
    ["Société Générale", ["Société Générale"]],
  ])("excluding %j hides exactly %j", async (name, hidden) => {
    const { companies } = await run({ excludedCompanies: [name] });
    expect(missing(COMPANIES, companies)).toEqual(hidden);
  });

  it("including punctuated names keeps exactly those employers", async () => {
    const { companies } = await run({ includedCompanies: ["O'Reilly Media", "Acme, Inc. (US)", "Under_score Co"] });
    expect(companies).toEqual(["O'Reilly Media", "Under_score Co", "Acme, Inc. (US)"]);
  });

  it("sole conflict (include Acme, exclude Acme) is an honest empty result, never all employers", async () => {
    const { companies, titles } = await run({ includedCompanies: ["Acme"], excludedCompanies: ["acme"] });
    expect(companies).toEqual([]);
    expect(titles).toEqual([]);
  });

  it("partial conflict keeps only the non-conflicting inclusions", async () => {
    const { companies } = await run({ includedCompanies: ["Acme", "Globex"], excludedCompanies: ["ACME"] });
    expect(companies).toEqual(["Globex"]);
  });
});

describe("title exclusion is a literal, case-insensitive substring", () => {
  it.each([
    ["C++", ["C++ Engineer"]],
    ["50%", ["50% Remote Analyst"]],
    ["data_engineer", ["Data_Engineer"]],
    ["(Platform)", ["Lead (Platform)"]],
    ["Path\\Finder", ["Path\\Finder"]],
    ["sale", ["Sales Engineer", "Wholesale Buyer"]],
  ])("excluding %j hides exactly %j", async (t, hidden) => {
    const { titles } = await run({ excludedTitles: [t] });
    expect(missing(TITLES, titles)).toEqual(hidden);
  });
});
