// LOCAL PREP ONLY (row 69). Records the REAL route filter code into a jsonb AST for the capture RPC. Unknown builder methods or
// grammar throw (fail closed): an unsupported clause is never silently dropped.
export type FilterNode = { and: FilterNode[] } | { or: FilterNode[] } | { col: string; op: string; not?: boolean; val?: unknown; quoted?: boolean };
const OPS = ["eq", "neq", "ilike", "imatch", "is", "gte", "lt", "lte"];
const splitTop = (s: string): string[] => { const out: string[] = []; let d = 0, cur = "", q = false;
  for (const ch of s) { if (ch === '"') q = !q; if (!q && ch === "(") d++; if (!q && ch === ")") d--; if (!q && d === 0 && ch === ",") { out.push(cur); cur = ""; } else cur += ch; }
  if (d !== 0 || q) throw new Error("unbalanced filter expression");
  out.push(cur); return out; };
const unq = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);
export function parseOrClause(expr: string): FilterNode {
  const term = (t: string): FilterNode => {
    const g = /^(and|or)\(([\s\S]*)\)$/.exec(t);
    if (g) return (g[1] === "and" ? { and: splitTop(g[2]).map(term) } : { or: splitTop(g[2]).map(term) }) as FilterNode;
    const m = new RegExp(`^([a-z_]+)\\.(not\\.)?(${OPS.join("|")})\\.([\\s\\S]*)$`, "").exec(t);
    if (!m) throw new Error("unsupported filter term");
    if (m[3] === "is") { if (m[4] !== "null") throw new Error("is non-null"); return { col: m[1], op: "is_null", not: !!m[2] }; }
    const quoted = m[4].startsWith('"') && m[4].endsWith('"'); return { col: m[1], op: m[3], not: !!m[2], val: unq(m[4]), ...(quoted ? { quoted } : {}) };
  };
  return { or: splitTop(expr).map(term) };
}
/** Canonical PostgREST or-string for a node (round-trip check of the parser, independent of SQL). */
export function serialize(n: FilterNode, top = true): string {
  if ("or" in n) { const j = n.or.map((x) => serialize(x, false)).join(","); return top ? j : `or(${j})`; }
  if ("and" in n) return `and(${n.and.map((x) => serialize(x, false)).join(",")})`;
  const op = n.op === "is_null" ? "is" : n.op; const val = n.op === "is_null" ? "null" : n.quoted ? `"${n.val}"` : String(n.val);
  return `${n.col}.${n.not ? "not." : ""}${op}.${val}`;
}
export function recorder() {
  const nodes: FilterNode[] = []; const raw: string[] = [];
  const impl: Record<string, (...a: any[]) => void> = {
    or: (e: string) => { raw.push(e); nodes.push(parseOrClause(e)); },
    eq: (c, v) => nodes.push({ col: c, op: "eq", val: v }),
    ilike: (c, v) => nodes.push({ col: c, op: "ilike", val: v }),
    in: (c, vs: unknown[]) => nodes.push({ or: vs.map((v) => ({ col: c, op: "eq", val: v })) }),
    not: (c, op, v) => { if (!OPS.includes(op)) throw new Error("unsupported not op"); nodes.push(v === null ? { col: c, op: "is_null", not: true } : { col: c, op, not: true, val: v }); },
    filter: (c, op, v) => { if (!OPS.includes(op)) throw new Error("unsupported filter op"); nodes.push({ col: c, op, val: v }); },
    gte: (c, v) => nodes.push({ col: c, op: "gte", val: v }),
  };
  const q: any = new Proxy({}, { get: (_t, k: string) => { if (!(k in impl)) throw new Error(`unsupported query method: ${String(k)}`); return (...a: any[]) => { impl[k](...a); return q; }; } });
  return { q, ast: (): FilterNode => ({ and: nodes }), raw: () => raw };
}
