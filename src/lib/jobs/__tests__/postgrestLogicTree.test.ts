// Differential check: the compiled, cached evaluator in postgrestLogicTree.ts must agree with the previous per-row
// interpreter (copied below verbatim from the pre-compilation revision, only renamed) on every expression and row.
import { describe, expect, it } from "vitest";
import { evalPostgrestNode, matchesPostgrestOr, splitTopLevel, type Tri } from "./postgrestLogicTree";

// ---- legacy evaluator (verbatim) ----
const ilike = (v: string, pat: string) =>
  new RegExp(
    "^" + pat.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*") + "$",
    "i"
  ).test(v);

function legacyEvalNode(node: string, row: Record<string, any>): Tri {
  const m = node.match(/^(and|or)\(([\s\S]*)\)$/);
  if (m) {
    const vals = splitTopLevel(m[2]).map((n) => legacyEvalNode(n, row));
    if (m[1] === "and") return vals.includes(false) ? false : vals.includes(null) ? null : true;
    return vals.includes(true) ? true : vals.includes(null) ? null : false;
  }
  const [col, ...rest] = node.split(".");
  const negate = rest[0] === "not";
  const [op, ...valParts] = negate ? rest.slice(1) : rest;
  const value = valParts.join(".");
  const v = row[col];
  let r: Tri;
  if (op === "is") r = value === "null" ? v === null || v === undefined : String(v) === value;
  else if (v === null || v === undefined) r = null;
  else if (op === "ilike") r = ilike(String(v), value);
  else if (op === "imatch") r = new RegExp(value.replace(/\\y/g, "\\b"), "i").test(String(v));
  else if (op === "eq") r = String(v) === value;
  else if (op === "neq") r = String(v) !== value;
  else if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
    const a = typeof v === "number" ? v : String(v);
    const b = typeof v === "number" ? Number(value) : value;
    r = op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
  } else r = false; // unsupported operator: never matches (same as the previous naive fakes)
  return negate && r !== null ? !r : r;
}

// ---- end legacy ----

const LEAVES = [
  "title.ilike.%engineer%", "title.ilike.Senior%", "title.ilike.%(c++)%", "title.ilike.%a.b%", "title.not.ilike.%intern%",
  "title.imatch.\\yreact\\y", "title.imatch.^front", "title.not.imatch.\\ysales\\y",
  "salary_min.gte.50000", "salary_min.lt.90000", "salary_min.gt.0", "salary_min.lte.120000", "posted_at.gte.2026-11-01T00:00:00Z",
  "country_code.eq.US", "country_code.neq.IN", "country_code.not.eq.US", "remote.is.true", "remote.is.null", "remote.not.is.null",
  "source_type.is.null", "source_type.neq.jobspy", "company.eq.a.b.c", "company.cs.{x}",
];
const ROWS: Array<Record<string, any>> = [
  { title: "Senior Frontend Engineer", salary_min: 95000, posted_at: "2026-11-20T00:00:00Z", country_code: "US", remote: true, source_type: null, company: "a.b.c" },
  { title: "React developer (c++)", salary_min: 40000, posted_at: "2026-10-01T00:00:00Z", country_code: "IN", remote: false, source_type: "jobspy", company: "x" },
  { title: "Sales Intern", salary_min: null, posted_at: null, country_code: null, remote: null, source_type: "ats" },
  { title: "frontend a.b lead", salary_min: "70000", country_code: "DE", remote: "true" },
  {},
];

describe("compiled PostgREST logic-tree evaluator == legacy interpreter", () => {
  let seed = 11;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
  const tree = (depth: number): string => {
    if (depth === 0 || rnd(3) === 0) return LEAVES[rnd(LEAVES.length)];
    const kids = Array.from({ length: 1 + rnd(3) }, () => tree(depth - 1));
    return `${rnd(2) ? "and" : "or"}(${kids.join(",")})`;
  };
  const exprs = [...LEAVES, ...Array.from({ length: 400 }, () => tree(3))];

  it("every node agrees on every row (three-valued), including repeated calls served from the cache", () => {
    let compared = 0;
    for (const e of exprs) for (const r of ROWS) for (let pass = 0; pass < 2; pass++) {
      const want: Tri = legacyEvalNode(e, r);
      expect(evalPostgrestNode(e, r), `${e} @ ${JSON.stringify(r)}`).toBe(want);
      compared++;
    }
    expect(compared).toBe(exprs.length * ROWS.length * 2);
  });

  it("matchesPostgrestOr agrees for top-level comma lists", () => {
    for (let i = 0; i < 200; i++) {
      const list = Array.from({ length: 1 + rnd(4) }, () => tree(2)).join(",");
      for (const r of ROWS) expect(matchesPostgrestOr(list, r), list).toBe(legacyEvalNode(`or(${list})`, r) === true);
    }
  });

  it("the generator really produces NULL, true and false outcomes (the comparison is not vacuous)", () => {
    const seen = new Set(exprs.flatMap((e) => ROWS.map((r) => String(legacyEvalNode(e, r)))));
    expect(seen).toEqual(new Set(["true", "false", "null"]));
    expect(splitTopLevel("a,and(b,c),d")).toEqual(["a", "and(b,c)", "d"]);
  });
});
