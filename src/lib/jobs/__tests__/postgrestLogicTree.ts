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

type Compiled = (row: Record<string, any>) => Tri;
// Expressions repeat on every row of every query; compiling each node once removes the per-row string splitting
// and RegExp construction. Evaluation logic is unchanged (pinned by postgrestLogicTree.test.ts against the old evaluator).
const compiled = new Map<string, Compiled>();

function compileNode(node: string): Compiled {
  const m = node.match(/^(and|or)\(([\s\S]*)\)$/);
  if (m) {
    const kids = splitTopLevel(m[2]).map(compile);
    if (m[1] === "and") {
      return (row) => { const vals = kids.map((k) => k(row)); return vals.includes(false) ? false : vals.includes(null) ? null : true; };
    }
    return (row) => { const vals = kids.map((k) => k(row)); return vals.includes(true) ? true : vals.includes(null) ? null : false; };
  }
  const [col, ...rest] = node.split(".");
  const negate = rest[0] === "not";
  const [op, ...valParts] = negate ? rest.slice(1) : rest;
  const value = valParts.join(".");
  const ilikeRe = op === "ilike"
    ? new RegExp("^" + value.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*") + "$", "i")
    : null;
  const imatchRe = op === "imatch" ? new RegExp(value.replace(/\\y/g, "\\b"), "i") : null;
  return (row) => {
    const v = row[col];
    let r: Tri;
    if (op === "is") r = value === "null" ? v === null || v === undefined : String(v) === value;
    else if (v === null || v === undefined) r = null;
    else if (op === "ilike") r = ilikeRe!.test(String(v));
    else if (op === "imatch") r = imatchRe!.test(String(v));
    else if (op === "eq") r = String(v) === value;
    else if (op === "neq") r = String(v) !== value;
    else if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
      const a = typeof v === "number" ? v : String(v);
      const b = typeof v === "number" ? Number(value) : value;
      r = op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
    } else r = false; // unsupported operator: never matches (same as the previous naive fakes)
    return negate && r !== null ? !r : r;
  };
}

function compile(node: string): Compiled {
  let c = compiled.get(node);
  if (!c) {
    if (compiled.size > 5000) compiled.clear(); // shortcut: crude bound for a test helper; fine while suites reuse few expressions
    c = compileNode(node);
    compiled.set(node, c);
  }
  return c;
}

export function evalPostgrestNode(node: string, row: Record<string, any>): Tri {
  return compile(node)(row);
}

/** True when a row passes a `.or(expr)` filter (rows evaluating NULL are excluded, as in SQL). */
export function matchesPostgrestOr(expr: string, row: Record<string, any>): boolean {
  return evalPostgrestNode(`or(${expr})`, row) === true;
}
