// @vitest-environment jsdom
// Jobs Overview Match Score: four tiles (overall + Experience Level, Skill, Role Match) only with a confirmed resume
// and usable diagnostics; honest states otherwise; Free/guest masking; no invented "Industry" dimension.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { LiveJob } from "@/lib/jobs/service";
import type { CandidateProfile } from "@/lib/resume/types";

vi.mock("@/components/CookieNotice", () => ({ useCookieNoticeHeight: () => 0 }));
vi.mock("@/components/CompanyLogo", () => ({ default: () => <div aria-hidden="true" /> }));
vi.mock("@/components/jobs/JobAiToolsPanel", () => ({ default: () => null }));
vi.mock("@/lib/matcher/scoring", async () => {
  const actual = await vi.importActual<typeof import("@/lib/matcher/scoring")>("@/lib/matcher/scoring");
  return { ...actual, computeFitDiagnostics: vi.fn(actual.computeFitDiagnostics) };
});

import JobDetailView, { type ResumeState } from "@/components/jobs/JobDetailView";
import { computeFitDiagnostics, displayMatchScore, toFitInput } from "@/lib/matcher/scoring";

const job: LiveJob = {
  id: "job-ms-1", title: "Senior Data Analyst", company: "Fixture Analytics", location: "Remote UK", date: "", postedAt: "",
  salary: "", category: "data", remote: true, country: "GB", type: "Full-time", directSource: true,
  applyUrl: "https://boards.greenhouse.io/fixture/jobs/1", skills: ["SQL", "Python", "Tableau"],
  description: "We need a senior data analyst with SQL, Python and Tableau to build dashboards and analysis.",
};
const candidate = (over: Partial<CandidateProfile> = {}): CandidateProfile => ({
  name: "A", email: "", phone: "", headline: "Data Analyst", summary: "", skills: ["SQL", "Python"],
  experience: [{ id: "e1", company: "X", role: "Data Analyst", startDate: "2019-01", endDate: "2025-01", bullets: [] }],
  education: [], certifications: [], confirmedAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", ...over,
});

function show(props: { job?: LiveJob; candidate?: CandidateProfile | null; isPro?: boolean; resumeState?: ResumeState }) {
  return render(
    <JobDetailView job={props.job ?? job} candidate={props.candidate === undefined ? candidate() : props.candidate} user={null}
      isPro={props.isPro ?? true} isSaved={false} onSave={() => {}} onApply={() => {}} onBack={() => {}}
      {...(props.resumeState ? { resumeState: props.resumeState } : {})} />,
  );
}
const tileTexts = (section: HTMLElement) =>
  [within(section).getByTestId("match-tile-overall"), ...within(section).getAllByTestId("match-tile")].map(
    (t) => `${t.querySelector("dd")?.textContent?.trim()} ${t.querySelector("dt")?.textContent?.trim()}`,
  );
const pct = (points: number, max: number) => Math.min(100, Math.max(0, Math.round((points / max) * 100)));

afterEach(() => { cleanup(); vi.mocked(computeFitDiagnostics).mockClear(); });

describe("Match Score with a confirmed resume and real diagnostics", () => {
  it("shows four tiles: overall (= displayMatchScore) with its label, then Experience Level, Skill and Role Match", () => {
    const d = computeFitDiagnostics(candidate(), toFitInput(job));
    const overall = displayMatchScore(job, d)!;
    show({});
    const section = screen.getByTestId("mobile-match-score");
    expect(within(section).getByRole("heading", { name: "Match Score" })).toBeTruthy();
    const label = overall > 70 ? "Great match" : overall >= 50 ? "Good match" : "Fair match";
    expect(tileTexts(section)).toEqual([
      `${overall}% ${label}`,
      `${pct(d.breakdown.experienceScore, 15)}% Experience Level`,
      `${pct(d.breakdown.skillScore, 50)}% Skill`,
      `${pct(d.breakdown.titleScore, 25)}% Role Match`,
    ]);
    expect(document.body.textContent).not.toMatch(/industry/i);
  });

  it("overall uses the server display score when the job carries one (same rule as cards)", () => {
    show({ job: { ...job, matchScore: 64 } });
    expect(within(screen.getByTestId("mobile-match-score")).getByTestId("match-tile-overall").textContent).toContain("64");
    expect(screen.getByTestId("desktop-match-score").textContent).toContain("64%");
  });

  it("a genuine 0 skill score renders 0%, not unavailable", () => {
    const c = candidate({ skills: ["Pottery"], headline: "Potter", experience: [] });
    const d = computeFitDiagnostics(c, toFitInput(job));
    expect(d.breakdown.skillScore).toBe(0); // precondition from the real scorer
    show({ candidate: c });
    const skill = within(screen.getByTestId("mobile-match-score")).getAllByTestId("match-tile")[1];
    expect(skill.textContent?.replace(/\s+/g, "")).toBe("0%Skill");
  });

  it("desktop breakdown is labelled Role Match, never Industry", () => {
    show({});
    const desktop = screen.getByTestId("desktop-match-score");
    expect(desktop.textContent).toContain("Role Match");
    expect(desktop.textContent).not.toMatch(/industry/i);
  });
});

describe("honest states: never a percentage", () => {
  const noNumbers = () => {
    expect(screen.queryByTestId("mobile-match-score")).toBeNull();
    expect(screen.queryByTestId("desktop-match-score")).toBeNull();
    expect(screen.queryAllByTestId("match-tile")).toHaveLength(0);
  };

  it("no resume: upload prompt on phone and desktop", () => {
    show({ candidate: null, resumeState: "none" });
    noNumbers();
    expect(screen.getByTestId("mobile-match-resume-prompt").textContent).toContain("Upload your resume");
    expect(screen.getByTestId("desktop-match-resume-prompt").textContent).toContain("Upload your resume");
  });

  it("unconfirmed resume: asks to confirm, does not score", () => {
    show({ candidate: null, resumeState: "unconfirmed" });
    noNumbers();
    expect(screen.getByTestId("mobile-match-resume-prompt").textContent).toContain("Confirm your resume");
    expect(computeFitDiagnostics).not.toHaveBeenCalled();
  });

  it("unconfirmed candidate passed without a state prop is still not scored", () => {
    show({ candidate: candidate({ confirmedAt: undefined }) });
    noNumbers();
    expect(screen.getByTestId("mobile-match-resume-prompt").getAttribute("data-state")).toBe("unconfirmed");
  });

  it("resume still loading: busy status, no prompt to upload", () => {
    show({ candidate: null, resumeState: "loading" });
    noNumbers();
    const status = screen.getByTestId("mobile-match-resume-prompt");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.textContent).not.toMatch(/upload/i);
  });

  it("missing diagnostics: unavailable, even if the job carries a server score", () => {
    vi.mocked(computeFitDiagnostics).mockImplementationOnce(() => { throw new Error("FIXTURE: diagnostics failed"); });
    show({ job: { ...job, matchScore: 71 } });
    noNumbers();
    expect(screen.getByTestId("mobile-match-resume-prompt").getAttribute("data-state")).toBe("unavailable");
    expect(screen.getByTestId("desktop-match-state").getAttribute("data-state")).toBe("unavailable");
    expect(document.body.textContent).not.toContain("71%");
  });
});

describe("masking", () => {
  it("Free with a confirmed resume but no server Free score: tiles are masked, no real percentage or match label", () => {
    show({ isPro: false });
    const section = screen.queryByTestId("mobile-match-score");
    // No Free-tier server number: the breakdown never renders real digits.
    if (section) expect(section.textContent).not.toMatch(/\d/);
  });

  it("Free with a server Free-tier score (.f.): overall number and label show, breakdown stays masked", () => {
    show({ isPro: false, candidate: null, job: { ...job, matchScore: 62, scoreRevision: "v.f.abc" } });
    const section = screen.getByTestId("mobile-match-score");
    expect(tileTexts(section)).toEqual(["62% Good match", "••% Experience Level", "••% Skill", "••% Role Match"]);
  });

  it("Free never shows a stale Pro-tier (.p.) score or a browser fit fallback", () => {
    show({ isPro: false, job: { ...job, matchScore: 91, scoreRevision: "v.p.abc" } });
    expect(document.body.textContent).not.toContain("91%");
    const section = screen.queryByTestId("mobile-match-score");
    if (section) expect(section.textContent).not.toMatch(/\d/);
  });

  it("guest (no candidate): upload prompt only", () => {
    show({ candidate: null, isPro: false });
    expect(screen.queryByTestId("mobile-match-score")).toBeNull();
    expect(screen.getByTestId("mobile-match-resume-prompt").getAttribute("data-state")).toBe("none");
  });
});
