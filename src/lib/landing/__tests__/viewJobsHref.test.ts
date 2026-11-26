import { describe, expect, it } from "vitest";
import { VIEW_JOBS_AUTH_HREF } from "../viewJobsHref";
import { getValidReturnUrl } from "@/lib/auth/returnTo";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("View Jobs auth-first CTA", () => {
  it("targets signup with a /jobs return that survives return validation", () => {
    const url = new URL(VIEW_JOBS_AUTH_HREF, "https://example.test");
    expect(url.pathname).toBe("/signup");
    expect(getValidReturnUrl(url.searchParams.get("next"), "/onboarding")).toBe("/jobs");
  });

  it("is used by the landing View Jobs CTAs and no bare /jobs View Jobs link remains", () => {
    const page = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");
    const globe = readFileSync(join(process.cwd(), "src/components/LandingGlobeFeatureSection.tsx"), "utf8");
    expect(page.match(/VIEW_JOBS_AUTH_HREF/g)?.length).toBeGreaterThanOrEqual(5);
    expect(globe).toContain("VIEW_JOBS_AUTH_HREF");
    expect(page).not.toMatch(/href="\/jobs"[^>]*>\s*View Jobs/);
  });
});
