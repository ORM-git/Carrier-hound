// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import JobDetailView from "../JobDetailView";
import type { LiveJob } from "@/lib/jobs/service";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: any) => <a href={typeof href === "string" ? href : "#"} {...p}>{children}</a> }));

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const job = (over: Partial<LiveJob> = {}): LiveJob => ({
  id: "fx-1", title: "Product Designer", company: "Fixture Co", location: "Remote", date: hoursAgo(2), postedAt: hoursAgo(2),
  salary: "", category: "design", remote: true, country: "US", type: "full-time", directSource: true,
  applyUrl: "https://careers.fixture.invalid/1", description: "Needs 5-8 years of product design work.", skills: ["Figma"], ...over,
});
const show = (j: LiveJob, isPro = true) =>
  render(<JobDetailView job={j} candidate={null} user={{ id: "u" } as any} isPro={isPro} isSaved={false} onSave={() => {}} onApply={() => {}} onToggleApplied={() => {}} onBack={() => {}} onHide={() => {}} />);
afterEach(cleanup);

describe("desktop detail layout (CM data)", () => {
  it("Overview/Company tabs and Share/Report/Original live in the card's tab row, not in the sticky strip", () => {
    show(job());
    const row = screen.getByTestId("overview-tab-row");
    expect(within(row).getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    expect(within(row).getByRole("tab", { name: "Company" }).getAttribute("aria-selected")).toBe("false");
    expect(within(row).getByTestId("share-job-button")).toBeTruthy();
    expect(within(row).getByTestId("report-issue-link")).toBeTruthy();
    expect(within(row).getByText("Linked Job Post")).toBeTruthy();
    const strip = screen.getByRole("region", { name: "Job header" });
    expect(within(strip).queryByTestId("share-job-button")).toBeNull();
    expect(within(strip).getByRole("button", { name: "Back to jobs list" })).toBeTruthy();
    expect(within(strip).getByRole("button", { name: "Hide position" })).toBeTruthy();
  });

  it("the strip shows an Early applicant chip only when the data says so", () => {
    show(job());
    const strip = screen.getByRole("region", { name: "Job header" });
    expect(within(strip).queryByText("Early applicant")).toBeTruthy();
    cleanup();
    show(job({ postedAt: hoursAgo(24 * 20), date: hoursAgo(24 * 20) }));
    expect(within(screen.getByRole("region", { name: "Job header" })).queryByText("Early applicant")).toBeNull();
  });

  it("experience text is never cut to 'N years of'", () => {
    show(job());
    expect(screen.queryByText(/years of$/)).toBeNull();
    expect(screen.getAllByText("5-8 years exp").length).toBeGreaterThan(0);
  });

  it("job type shows only a real type, canonically cased, and never an invented Full-time", () => {
    show(job({ type: "part-time" }));
    expect(screen.getAllByText("Part-time").length).toBeGreaterThan(0);
    cleanup();
    show(job({ type: "" as any }));
    expect(screen.queryByText(/full-time/i)).toBeNull();
    cleanup();
    show(job({ type: "unknown" as any }));
    expect(screen.queryByText(/full-time|unknown/i)).toBeNull();
  });

  it("no score is invented: Free and guest see the resume prompt, never a percentage panel", () => {
    show(job({ matchScore: 77 } as any), false);
    expect(screen.queryByTestId("desktop-match-score")).toBeNull();
    expect(screen.queryByText("77%")).toBeNull();
  });
});
