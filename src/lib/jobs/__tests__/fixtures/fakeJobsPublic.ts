// FIXTURE jobs_public for the For You (resume) direct path. Honours only what that path's continuation depends on:
// (posted_at desc nulls last, id desc) order, the (posted_at, id) keyset clause, the posted_at date window, range,
// an injectable error and a switchable session.
// Title/visibility filters are not under test, so every fixture row is a title match.

export const db = {
  rows: [] as any[],
  queries: 0,
  failAt: null as number | null,
  onQuery: null as null | ((n: number) => void),
  /** What auth.getSession() returns: the viewer and its sign-in epoch (no real token). */
  session: null as any,
};
const DEFAULT_SESSION = { access_token: "fixture-token", user: { id: "viewer-a", last_sign_in_at: "2026-11-25T08:00:00Z" } };
db.session = DEFAULT_SESSION;
export const getSession = async () => ({ data: { session: db.session }, error: null });

export function resetDb() {
  db.rows = [];
  db.queries = 0;
  db.failAt = null;
  db.onQuery = null;
  db.session = DEFAULT_SESSION;
}

export function cmp(a: any, b: any) {
  if (a.posted_at !== b.posted_at) {
    if (a.posted_at === null) return 1;
    if (b.posted_at === null) return -1;
    return a.posted_at < b.posted_at ? 1 : -1;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function table() {
  const preds: Array<(r: any) => boolean> = [];
  let range: [number, number] | null = null;
  const run = () => {
    const n = ++db.queries;
    db.onQuery?.(n);
    if (db.failAt === n) return { data: null, count: null, error: { message: "fixture failure" } };
    const all = db.rows.filter((r) => preds.every((p) => p(r))).sort(cmp);
    return { data: range ? all.slice(range[0], range[1] + 1) : all, count: all.length, error: null };
  };
  const b: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (res: any, rej: any) => Promise.resolve(run()).then(res, rej);
      if (prop === "range") return (f: number, t: number) => ((range = [f, t]), b);
      if (prop === "or") return (clause: string) => {
        const m = clause.match(/^posted_at\.lt\.([^,]+),and\(posted_at\.eq\.([^,]+),id\.lt\.([^)]+)\),posted_at\.is\.null$/);
        if (m) preds.push((r) => r.posted_at === null || r.posted_at < m[1] || (r.posted_at === m[2] && r.id < m[3]));
        return b;
      };
      if (prop === "is") return (c: string, v: any) => (preds.push((r) => r[c] === v), b);
      if (prop === "gte") return (c: string, v: any) => (preds.push((r) => r[c] !== null && r[c] >= v), b);
      if (prop === "lt") return (c: string, v: any) => (preds.push((r) => r[c] < v), b);
      return () => b; // select / eq / order / not / in / abortSignal
    },
  });
  return b;
}

export const CANDIDATE = { headline: "Software Engineer", skills: ["typescript", "react"], experience: [{ role: "Software Engineer" }] } as any;
export const PREFS = { roles: ["Software Engineer"], experienceLevel: "entry" } as any;
export const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
/** Row i (1-based) in newest-first order: strictly decreasing timestamps unless postedAt is given. */
export const job = (i: number, title: string, postedAt: string | null = new Date(Date.UTC(2026, 10, 25) - i * 60_000).toISOString()) => ({
  id: uuid(100_000 - i), title, location: "Bengaluru, India", category: "engineering", remote: false,
  country_code: "IN", job_type: "full-time", verified: true, posted_at: postedAt, created_at: postedAt,
});
export const junior = (i: number) => job(i, "Junior Software Engineer");
export const senior = (i: number) => job(i, "Senior Software Engineer");
/** The confirmed counterexample: 25 eligible + 225 ineligible in the first 250 rows, one more eligible at row 251. */
export const rows251 = () => [...Array.from({ length: 250 }, (_, k) => (k < 25 ? junior(k + 1) : senior(k + 1))), junior(251)];
