// Pro detail (/api/jobs/pro?id=) -> LiveJob: employer logo and domain resolve like the Pro listing
// (job logo, then companies.logo_url; companies.domain), so a direct link shows the same logo as the card.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "fixture-token" } } }) } }),
}));

import { getLiveJobById } from "@/lib/jobs/service";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function serve(job: Record<string, unknown>) {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ job, isPro: true }), { status: 200 })) as any;
}
const base = { id: "fx-1", title: "Fixture Role", company: "Fixture Employer", status: "active", is_active: true, apply_url: "https://boards.greenhouse.io/fx/1" };

describe("getLiveJobById (Pro) logo identity", () => {
  it("uses companies.logo_url and companies.domain when the job row has no logo", async () => {
    serve({ ...base, companies: { logo_url: "https://cdn.fx-employer.invalid/l.png", domain: "fx-employer.invalid" } });
    const job = await getLiveJobById("fx-1", true);
    expect([job?.logoUrl, job?.logo_url, job?.companyDomain]).toEqual(["https://cdn.fx-employer.invalid/l.png", "https://cdn.fx-employer.invalid/l.png", "fx-employer.invalid"]);
  });

  it("a job-row logo wins; no company data means no domain (never guessed)", async () => {
    serve({ ...base, logo_url: "https://cdn.row.invalid/r.png", companies: null });
    const job = await getLiveJobById("fx-1", true);
    expect([job?.logoUrl, job?.companyDomain]).toEqual(["https://cdn.row.invalid/r.png", null]);
  });
});
