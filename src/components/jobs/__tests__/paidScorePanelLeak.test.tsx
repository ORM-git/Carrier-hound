// @vitest-environment jsdom
// Paid-only score (owner, 24 Nov): the REAL Match Insights panel and detail view must not render the numeric score,
// matched/missing skills or breakdown for Free/guest, including after a Pro->Free downgrade with a stale cached score.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { LiveJob } from "@/lib/jobs/service";
import type { CandidateProfile } from "@/lib/resume/types";

vi.mock("@/components/CookieNotice", () => ({ useCookieNoticeHeight: () => 0 }));
vi.mock("@/components/CompanyLogo", () => ({ default: () => <div aria-hidden="true" /> }));

import JobDetailView from "@/components/jobs/JobDetailView";
import JobAiToolsPanel from "@/components/jobs/JobAiToolsPanel";
import { computeFitDiagnostics, toFitInput } from "@/lib/matcher/scoring";

const SENTINEL = "ZzPrivateSkillSentinel";
const job: LiveJob = {
  id: "job-leak-1", title: "Senior Data Analyst", company: "Fixture Analytics", location: "Remote UK", date: "", postedAt: "",
  salary: "", category: "data", remote: true, country: "GB", type: "Full-time", directSource: true,
  applyUrl: "https://boards.greenhouse.io/fixture/jobs/1", skills: ["SQL", "Python", SENTINEL],
  description: "We need a senior data analyst with SQL, Python and " + SENTINEL + " to build dashboards and analysis.",
  matchScore: 87,
};
const candidate: CandidateProfile = {
  name: "A", email: "", phone: "", headline: "Data Analyst", summary: "", skills: ["SQL", "Python"],
  experience: [{ id: "e1", company: "X", role: "Data Analyst", startDate: "2019-01", endDate: "2025-01", bullets: [] }],
  education: [], certifications: [], confirmedAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z",
};
const diag = () => computeFitDiagnostics(candidate, toFitInput(job));
const noop = () => {};
const panel = (isPro: boolean, user: any = null, j: LiveJob = job) => (
  <JobAiToolsPanel job={j} candidate={candidate} user={user} isPro={isPro} diagnostics={diag()} isSaved={false} onSave={noop} />
);
const detail = (isPro: boolean, j: LiveJob = job) => (
  <JobDetailView job={j} candidate={candidate} user={null} isPro={isPro} isSaved={false} onSave={noop} onApply={noop} onBack={noop} />
);
afterEach(cleanup);

describe("Match Insights panel entitlement", () => {
  it("Pro positive control: score, breakdown and skills render", () => {
    const { container, queryByTestId } = render(panel(true));
    expect(queryByTestId("ai-tools-match-badge")?.textContent).toContain("87% Match");
    expect(queryByTestId("ai-tools-match-breakdown")).toBeTruthy();
    expect(container.textContent).toContain("87% match score");
  });
  it("Free (signed in) and guest: no numeric score, breakdown, skills or sentinel in the panel", () => {
    for (const user of [null, { id: "u1" }]) {
      const { container, queryByTestId } = render(panel(false, user));
      expect(queryByTestId("ai-tools-match-badge")).toBeNull();
      expect(queryByTestId("ai-tools-match-breakdown")).toBeNull();
      expect(queryByTestId("ai-tools-matched-skills")).toBeNull();
      expect(queryByTestId("ai-tools-missing-skills")).toBeNull();
      expect(container.textContent).not.toMatch(/87|% match|% Match/);
      expect(container.textContent).not.toContain(SENTINEL);
      cleanup();
    }
  });
  it("Pro row with a server unlock error is treated as locked", () => {
    const { queryByTestId } = render(panel(true, null, { ...job, proUnlockError: "failed" } as LiveJob));
    expect(queryByTestId("ai-tools-match-badge")).toBeNull();
    expect(queryByTestId("ai-tools-match-breakdown")).toBeNull();
  });
});

describe("Detail view with stale Pro cache / downgrade", () => {
  it("Pro -> Free on the same job object (stale 87 cached): no 87 or skills reach the DOM", () => {
    const { container, rerender, queryByTestId } = render(detail(true));
    expect(queryByTestId("ai-tools-match-badge")?.textContent).toContain("87");
    rerender(detail(false));
    expect(queryByTestId("ai-tools-match-badge")).toBeNull();
    expect(queryByTestId("ai-tools-match-breakdown")).toBeNull();
    expect(container.textContent).not.toContain("87");
    expect(queryByTestId("ai-tools-matched-skills")).toBeNull();
    expect(queryByTestId("ai-tools-missing-skills")).toBeNull();
  });
  it("Free from the start: panel shows nothing numeric", () => {
    const { container, queryByTestId } = render(detail(false));
    expect(queryByTestId("ai-tools-match-badge")).toBeNull();
    expect(queryByTestId("ai-tools-match-breakdown")).toBeNull();
    expect(container.textContent).not.toMatch(/\b87\s*%/);
  });
});
