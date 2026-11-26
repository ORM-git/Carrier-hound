/**
 * Test-only evaluator for PostgREST logic-tree filter strings (the argument of `.or()`), with SQL
 * three-valued NULL semantics. Used by in-memory Supabase fakes so nested `and(...)`/`or(...)`
 * clauses are evaluated the way PostgREST/Postgres would, instead of a naive comma split.
 */
export type Tri = boolean | null;

export function splitTopLevel(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const ilike = (v: string, pat: string) =>
  new RegExp(
    "^" + pat.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*") + "$",
    "i"
  ).test(v);

export function evalPostgrestNode(node: string, row: Record<string, any>): Tri {
  const m = node.match(/^(and|or)\(([\s\S]*)\)$/);
  if (m) {
    const vals = splitTopLevel(m[2]).map((n) => evalPostgrestNode(n, row));
    if (m[1] === "and") return vals.includes(false) ? false : vals.includes(null) ? null : true;
    return vals.includes(true) ? true : vals.includes(null) ? null : false;
  }
  const [col, ...rest] = node.split(".");
  const negate = rest[0] === "not";
  const [op, ...valParts] = negate ? rest.slice(1) : rest;
  let value = valParts.join(".");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1); // quoted value
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

/** True when a row passes a `.or(expr)` filter (rows evaluating NULL are excluded, as in SQL). */
export function matchesPostgrestOr(expr: string, row: Record<string, any>): boolean {
  return evalPostgrestNode(`or(${expr})`, row) === true;
}
