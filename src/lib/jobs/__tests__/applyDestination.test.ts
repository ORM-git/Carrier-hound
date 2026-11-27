import { describe, it, expect } from "vitest";
import { classifyApplyDestination, AGGREGATOR_DOMAINS } from "../applyDestination";
import registry from "../../../../data/ats-company-registry.json";

const tokenFor = (ats: string) => (registry as Array<{ ats: string; token: string }>).find((e) => e.ats === ats)!.token;

describe("classifyApplyDestination", () => {
  it.each([
    ["greenhouse", "boards.greenhouse.io", "/jobs/101"],
    ["lever", "jobs.lever.co", "/abc-123"],
    ["ashby", "jobs.ashbyhq.com", "/oai-1"],
  ])("registry-backed %s board URL -> employer_board with matchedToken", (ats, host, rest) => {
    const token = tokenFor(ats);
    expect(classifyApplyDestination(`https://${host}/${token}${rest}`)).toEqual({ kind: "employer_board", domain: host, matchedToken: token });
    expect(classifyApplyDestination(`https://${host}/${token.toUpperCase()}${rest}?gh_src=x`).kind).toBe("employer_board");
  });

  it.each([
    "https://boards.greenhouse.io/zz-not-a-registry-token-9/jobs/1",
    "https://jobs.lever.co/zz-not-a-registry-token-9/abc",
    "https://jobs.ashbyhq.com/zz-not-a-registry-token-9",
    "https://boards.greenhouse.io/",
    "https://boards.greenhouse.io/embed/job_app?for=stripe", // unrecognized shape on a shared host
  ])("same ATS host, unknown token or shape -> unknown (%s)", (u) => {
    expect(classifyApplyDestination(u).kind).toBe("unknown");
  });

  it("a registry token under the wrong ATS host is not an employer board", () => {
    const leverOnly = (registry as Array<{ ats: string; token: string }>).find(
      (e) => e.ats === "lever" && !(registry as Array<{ ats: string; token: string }>).some((g) => g.ats === "greenhouse" && g.token === e.token),
    )!.token;
    expect(classifyApplyDestination(`https://boards.greenhouse.io/${leverOnly}/jobs/1`).kind).toBe("unknown");
  });

  it.each([
    ["https://www.indeed.com/viewjob?jk=1", "www.indeed.com"],
    ["https://in.indeed.com/viewjob?jk=1", "in.indeed.com"],
    ["https://www.linkedin.com/jobs/view/1", "www.linkedin.com"],
    ["https://www.adzuna.in/land/ad/1", "www.adzuna.in"],
    ["https://remotive.com/remote-jobs/x", "remotive.com"],
    ["http://weworkremotely.com/remote-jobs/x", "weworkremotely.com"],
  ])("aggregator platform %s", (u, domain) => {
    expect(classifyApplyDestination(u)).toEqual({ kind: "aggregator_platform", domain });
  });

  it.each([
    "https://indeed.com.evil.example/viewjob",
    "https://indeedjobs.com/x",
    "https://notindeed.com/x",
    "https://linkedin.com-careers.example/x",
    "https://boards.greenhouse.io.evil.example/stripe/jobs/1",
    "https://evil-boards.greenhouse.io/stripe/jobs/1",
    "https://jobs.lever.co.attacker.example/spotify/x",
  ])("lookalike / attack host -> unknown, never employer or aggregator (%s)", (u) => {
    expect(classifyApplyDestination(u).kind).toBe("unknown");
  });

  it.each([
    "", "   ", "not a url", "javascript:alert(1)", "ftp://boards.greenhouse.io/stripe/jobs/1",
    "data:text/html,hi", "https://user:pass@boards.greenhouse.io/stripe/jobs/1", "https://user@indeed.com/x",
    "https://boards.greenhouse.io/%E0%A4%A/jobs/1", "//indeed.com/x",
  ])("malformed / non-http / credentialed %j -> unknown, no throw", (u) => {
    expect(() => classifyApplyDestination(u)).not.toThrow();
    expect(classifyApplyDestination(u).kind).toBe("unknown");
  });

  it.each([null, undefined, 42 as unknown as string, {} as unknown as string])("non-string input %j -> unknown, no throw", (u) => {
    expect(classifyApplyDestination(u as any)).toEqual({ kind: "unknown", domain: null });
  });

  it("employer sites outside the registry are unknown, not assumed employer", () => {
    expect(classifyApplyDestination("https://careers.example.com/jobs/1")).toEqual({ kind: "unknown", domain: "careers.example.com" });
  });

  it("source independence: identical URLs classify identically whatever the job's source", () => {
    const urls = [
      `https://boards.greenhouse.io/${tokenFor("greenhouse")}/jobs/1`,
      "https://www.indeed.com/viewjob?jk=1",
      "https://careers.example.com/jobs/1",
    ];
    // The classifier's only parameter is the URL; extra arguments (a source value) cannot change the result.
    expect(classifyApplyDestination.length).toBe(1);
    for (const u of urls) {
      const base = classifyApplyDestination(u);
      for (const source of ["ats", "direct", "aggregator", "feed", "jobspy", "greenhouse", "adzuna", null]) {
        const job = { apply_url: u, source_type: source, source };
        expect((classifyApplyDestination as any)(job.apply_url, job.source_type, job)).toEqual(base);
      }
    }
  });

  it("aggregator list stays explicit: no wildcard or partial entries", () => {
    for (const d of AGGREGATOR_DOMAINS) expect(d).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
  });
});
