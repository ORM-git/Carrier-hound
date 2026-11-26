import { afterEach, describe, expect, it, vi } from "vitest";
import { getLiveJobs, mergeFeedConstraints } from "@/lib/jobs/service";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => { throw new Error("no client in test"); } }));

describe("mergeFeedConstraints (saved AND transient lists)", () => {
  it("adds exclusions and intersects inclusions case-insensitively", () => {
    const c = mergeFeedConstraints(
      { excludedTitles: ["Senior"], includedCompanies: ["Acme", "Globex"], excludedCompanies: ["Initech"] },
      { excludedTitles: ["intern"], includedCompanies: ["acme"], excludedCompanies: ["Umbrella"] }
    );
    expect(c.excludedTitles).toEqual(["Senior", "intern"]);
    expect(c.includedCompanies).toEqual(["Acme"]);
    expect(c.excludedCompanies).toEqual(["Initech", "Umbrella"]);
  });
  it("an empty inclusion intersection matches nothing (include X + exclude X), never all employers", () => {
    const c = mergeFeedConstraints({ includedCompanies: ["Acme"] }, { includedCompanies: ["Globex"] });
    expect(c.includedCompanies).toEqual(["Acme"]);
    expect(c.excludedCompanies).toEqual(["Acme"]);
  });
  it("one side only: that side's inclusion list applies", () => {
    expect(mergeFeedConstraints(null, { includedCompanies: ["Globex"] }).includedCompanies).toEqual(["Globex"]);
  });
});

describe("getLiveJobs list params follow the owner flag", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  const run = async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ jobs: [], totalCount: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await getLiveJobs({ baseUrl: "http://t", sortBy: "newest", excludedTitles: ["Senior"], includedCompanies: ["Acme, Inc."], excludedCompanies: ["Initech"] });
    return new URL(String((fetchMock.mock.calls as unknown as Array<[string]>)[0][0])).searchParams;
  };
  it("flag off (default): no list params are sent", async () => {
    const p = await run();
    expect(p.getAll("excludeTitle")).toEqual([]);
    expect(p.getAll("includeCompany")).toEqual([]);
    expect(p.getAll("excludeCompany")).toEqual([]);
  });
  it("flag on: repeated params are sent (names with commas survive)", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "true");
    const p = await run();
    expect(p.getAll("excludeTitle")).toEqual(["Senior"]);
    expect(p.getAll("includeCompany")).toEqual(["Acme, Inc."]);
    expect(p.getAll("excludeCompany")).toEqual(["Initech"]);
  });
});
