// Real getLiveJobById: concurrent same-id Pro requests share one round trip, each caller gets its own copy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "fixture-token" } } }) } }),
}));
vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => ({ env: undefined }) }));
import { getLiveJobById } from "@/lib/jobs/service";

const realFetch = globalThis.fetch;
let fetched: string[] = [];
let release!: () => void;
beforeEach(() => {
  fetched = [];
  const gate = new Promise<void>((r) => { release = r; });
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = String(input);
    fetched.push(url);
    await gate;
    const id = decodeURIComponent(url.split("id=")[1]);
    return new Response(JSON.stringify({ job: { id, title: `T ${id}`, company: "Acme", description: `FULL ${id} ` + "x".repeat(80), skills: ["SQL"], apply_url: "https://x.invalid/a", status: "active", is_active: true } }), { status: 200 });
  }) as any;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe("getLiveJobById concurrency", () => {
  it("two concurrent calls for the same id make one request and return independent copies", async () => {
    const a = getLiveJobById("fx-1", true);
    const b = getLiveJobById("fx-1", true);
    release();
    const [ja, jb] = await Promise.all([a, b]);
    expect(fetched.filter((u) => u.includes("/api/jobs/pro?id=fx-1"))).toHaveLength(1);
    expect(ja?.description).toContain("FULL fx-1");
    expect(jb?.description).toBe(ja?.description);
    expect(ja).not.toBe(jb);
    ja!.matchScore = 99;
    expect(jb!.matchScore).not.toBe(99);
  });

  it("different ids are never merged, and a finished request is not reused (a later call fetches again)", async () => {
    release();
    const [x, y] = await Promise.all([getLiveJobById("fx-1", true), getLiveJobById("fx-2", true)]);
    expect([x?.id, y?.id]).toEqual(["fx-1", "fx-2"]);
    expect(fetched).toHaveLength(2);
    await getLiveJobById("fx-1", true);
    expect(fetched).toHaveLength(3);
  });
});
