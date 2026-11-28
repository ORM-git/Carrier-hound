import { PGlite } from "@electric-sql/pglite";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { fetchLatestTypescriptRunMeta, PYTHON_RUN_FILTER_COLUMN } from "../observability/radarRunMeta";

type Row = { started_at: string | null; finished_at: string | null; status: string; per_source_counts: Record<string, unknown> | null };

const TS_OK: Row = { started_at: "2026-11-28T10:00:00Z", finished_at: "2026-11-28T10:30:00Z", status: "success", per_source_counts: { "greenhouse-a": 1, coverage: { cycle_id: "c1", shard_id: 0 } } };
const PY_FAILED_NULL_START: Row = { started_at: null, finished_at: "2026-11-28T11:00:00Z", status: "failed", per_source_counts: { python_run: { pipeline: "python", cohort: "workday", outcome: "no_report" } } };
const PY_LATER: Row = { started_at: "2026-11-28T12:00:00Z", finished_at: "2026-11-28T12:20:00Z", status: "failed", per_source_counts: { "greenhouse:x": null, python_run: { pipeline: "python", cohort: "non-workday", outcome: "failed" } } };

/** Fake builder with Postgres semantics for the calls used: `col->key IS NULL`, ORDER BY DESC (NULLs first), LIMIT. */
function fakeSupabase(rows: Row[]) {
  const calls: unknown[][] = [];
  let out = rows.slice();
  const b: any = {
    select: (c: string) => (calls.push(["select", c]), b),
    is: (col: string, v: null) => {
      calls.push(["is", col, v]);
      const [jsonCol, key] = col.split("->");
      out = out.filter((r) => {
        const obj = (r as any)[jsonCol];
        return obj === null || obj === undefined || !(key in obj); // SQL NULL only when the key is absent
      });
      return b;
    },
    order: (col: string, o: { ascending: boolean }) => {
      calls.push(["order", col, o]);
      out.sort((x: any, y: any) => {
        const a = x[col], z = y[col];
        if (a === z) return 0;
        if (a === null) return -1; // DESC puts NULLs first in Postgres
        if (z === null) return 1;
        return o.ascending ? (a < z ? -1 : 1) : (a < z ? 1 : -1);
      });
      return b;
    },
    limit: (n: number) => (calls.push(["limit", n]), (out = out.slice(0, n)), b),
    maybeSingle: async () => ({ data: out[0] ? { finished_at: out[0].finished_at, total_active: null, total_verified: null } : null, error: null }),
  };
  return { client: { from: (t: string) => (calls.push(["from", t]), b) }, calls };
}

describe("radar data-as-of: latest TypeScript run only", () => {
  it("ignores a null-started_at failed Python row and a later failed Python row", async () => {
    const { client } = fakeSupabase([PY_FAILED_NULL_START, TS_OK, PY_LATER]);
    expect((await fetchLatestTypescriptRunMeta(client))?.finished_at).toBe(TS_OK.finished_at);
  });

  it("negative control: without the filter the null-started_at Python row would win under DESC", async () => {
    const { client } = fakeSupabase([PY_FAILED_NULL_START, TS_OK, PY_LATER]);
    const b: any = client.from("ingest_runs");
    const { data } = await b.select("finished_at").order("started_at", { ascending: false }).limit(1).maybeSingle();
    expect(data.finished_at).toBe(PY_FAILED_NULL_START.finished_at);
  });

  it("Python-only rows return null", async () => {
    const { client } = fakeSupabase([PY_FAILED_NULL_START, PY_LATER]);
    expect(await fetchLatestTypescriptRunMeta(client)).toBeNull();
  });

  it("sends the Python filter before the order", async () => {
    const { client, calls } = fakeSupabase([TS_OK]);
    await fetchLatestTypescriptRunMeta(client);
    const names = calls.map((c) => c[0]);
    expect(calls).toContainEqual(["is", "per_source_counts->python_run", null]);
    expect(names.indexOf("is")).toBeLessThan(names.indexOf("order"));
    expect(calls).toContainEqual(["order", "started_at", { ascending: false }]);
  });

  it("installed supabase-js serializes the filter as per_source_counts->python_run=is.null", async () => {
    const urls: URL[] = [];
    const client = createClient("http://supabase.test", "test-anon-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (input: RequestInfo | URL) => {
          urls.push(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url));
          return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    });
    expect(await fetchLatestTypescriptRunMeta(client)).toBeNull();
    expect(urls).toHaveLength(1);
    const q = urls[0].searchParams;
    expect(urls[0].pathname).toBe("/rest/v1/ingest_runs");
    expect(q.get(PYTHON_RUN_FILTER_COLUMN)).toBe("is.null");
    expect(q.get("order")).toBe("started_at.desc");
    expect(q.get("limit")).toBe("1");
    expect(q.get("select")?.replace(/\s/g, "")).toBe("finished_at,total_active,total_verified");
  });

  it("Postgres (PGlite) JSON null semantics of the condition PostgREST generates for that filter", async () => {
    const db = new PGlite();
    try {
      await db.exec(`create table ingest_runs (started_at timestamptz, finished_at timestamptz, status text, per_source_counts jsonb)`);
      const rows: Array<[string | null, string, string, string | null]> = [
        [TS_OK.started_at, TS_OK.finished_at!, "success", JSON.stringify(TS_OK.per_source_counts)],
        [null, PY_FAILED_NULL_START.finished_at!, "failed", JSON.stringify(PY_FAILED_NULL_START.per_source_counts)],
        [PY_LATER.started_at, PY_LATER.finished_at!, "failed", JSON.stringify(PY_LATER.per_source_counts)],
        ["2026-11-28T09:00:00Z", "2026-11-28T09:10:00Z", "success", null],                         // TS row, no counts
        ["2026-11-28T13:00:00Z", "2026-11-28T13:10:00Z", "success", JSON.stringify({ python_run: null })], // explicit JSON null
      ];
      for (const r of rows) await db.query(`insert into ingest_runs values ($1, $2, $3, $4::jsonb)`, r);
      const kept = await db.query<{ finished_at: Date }>(
        `select finished_at from ingest_runs where "per_source_counts"->'python_run' is null order by started_at desc`);
      // key absent or counts NULL -> kept; Python object -> dropped; explicit JSON null -> jsonb 'null' is not SQL NULL -> dropped
      expect(kept.rows.map((r) => new Date(r.finished_at).toISOString())).toEqual(["2026-11-28T10:30:00.000Z", "2026-11-28T09:10:00.000Z"]);
      const unfiltered = await db.query<{ finished_at: Date }>(`select finished_at from ingest_runs order by started_at desc limit 1`);
      expect(new Date(unfiltered.rows[0].finished_at).toISOString()).toBe("2026-11-28T11:00:00.000Z"); // NULL started_at sorts first
    } finally {
      await db.close();
    }
  }, 30_000); // PGlite boot takes ~4s locally; never race vitest's 5s default under full-suite load
});
