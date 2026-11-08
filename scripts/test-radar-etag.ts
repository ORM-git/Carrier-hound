/**
 * Offline test for conditional GET on /api/radar (Backend sheet row 97).
 * Run: npx tsx scripts/test-radar-etag.ts
 * Body, status and cache headers must stay as before; only ETag and 304 are added.
 */
import fs from "node:fs";
import path from "node:path";
import { radarJsonResponse } from "../src/lib/api/radarResponse";
import { computeWeakEtag } from "../src/lib/api/etag";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const payload = {
  header: { totalActive: 3, totalVerified: 1, dataAsOf: "2026-11-06T00:00:00Z" },
  cities: [{ id: "x", name: "X", totalCount: 3 }],
  countries: {},
  worldwideRemote: { id: "w", totalCount: 0 },
  unlocated: { id: "u", totalCount: 0 },
};
const CACHE = "public, s-maxage=300, stale-while-revalidate=600";
const H = (c: "HIT" | "MISS") => ({ "Cache-Control": CACHE, "X-Cache": c });
const req = (h?: Record<string, string>) => new Request("https://x.test/api/radar", { headers: h });

async function main() {
  const miss = await radarJsonResponse(req(), payload, H("MISS"));
  check("200 on a plain request", miss.status === 200);
  check("body is exactly the JSON of the payload", (await miss.text()) === JSON.stringify(payload));
  check("Cache-Control unchanged", miss.headers.get("cache-control") === CACHE);
  check("X-Cache MISS unchanged", miss.headers.get("x-cache") === "MISS");
  check("content-type is JSON", (miss.headers.get("content-type") || "").includes("application/json"));
  const etag = miss.headers.get("etag") || "";
  check("ETag added and equals the weak etag of the payload", etag === (await computeWeakEtag(payload)) && /^W\/"[0-9a-f]{32}"$/.test(etag));

  const hit = await radarJsonResponse(req(), payload, H("HIT"));
  check("X-Cache HIT unchanged", hit.headers.get("x-cache") === "HIT");
  check("same payload gives the same ETag on HIT and MISS", hit.headers.get("etag") === etag);

  const nm = await radarJsonResponse(req({ "if-none-match": etag }), payload, H("HIT"));
  check("matching If-None-Match gives 304", nm.status === 304);
  check("304 has no body", (await nm.text()) === "");
  check("304 keeps Cache-Control, X-Cache and ETag", nm.headers.get("cache-control") === CACHE && nm.headers.get("x-cache") === "HIT" && nm.headers.get("etag") === etag);

  const other = await radarJsonResponse(req({ "if-none-match": 'W/"deadbeef"' }), payload, H("MISS"));
  check("non-matching If-None-Match gives the normal 200 body", other.status === 200 && (await other.text()) === JSON.stringify(payload));

  const changed = await radarJsonResponse(req({ "if-none-match": etag }), { ...payload, header: { ...payload.header, totalActive: 4 } }, H("MISS"));
  check("changed payload with an old tag gives 200, not 304", changed.status === 200);

  const noReq = await radarJsonResponse(undefined, payload, H("MISS"));
  check("no request object still gives the normal 200", noReq.status === 200 && noReq.headers.get("etag") === etag);

  const route = fs.readFileSync(path.join(__dirname, "../src/app/api/radar/route.ts"), "utf8");
  check("route success paths both use radarJsonResponse (HIT and MISS) with the same cache headers",
    /radarJsonResponse\(req, memoryCache\.payload, \{\s*'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',\s*'X-Cache': 'HIT',/.test(route)
    && /radarJsonResponse\(req, payload, \{\s*'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',\s*'X-Cache': 'MISS',/.test(route));
  check("route error responses are unchanged",
    /\{ error: 'Supabase credentials not configured' \}, \{ status: 500 \}/.test(route) && /\{ error: err\.message \}, \{ status: 500 \}/.test(route));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
