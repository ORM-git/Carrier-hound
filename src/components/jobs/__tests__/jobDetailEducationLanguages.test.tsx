// @vitest-environment jsdom
// Row 26: explicit headed Education / Languages lists in the description render as their own sections;
// nothing is shown (or inferred) when the description has no such headed list.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { LiveJob } from "@/lib/jobs/service";

vi.mock("@/components/CookieNotice", () => ({ useCookieNoticeHeight: () => 0 }));
vi.mock("@/components/CompanyLogo", () => ({ default: () => <div aria-hidden="true" /> }));
vi.mock("@/components/jobs/JobAiToolsPanel", () => ({ default: () => null }));

import JobDetailView from "@/components/jobs/JobDetailView";

const base: LiveJob = {
  id: "job-el-1", title: "Data Analyst", company: "Fixture Analytics", location: "Remote UK", date: "", postedAt: "",
  salary: "", category: "data", remote: true, country: "GB", type: "Full-time", directSource: true,
  applyUrl: "https://boards.greenhouse.io/fixture/jobs/1", skills: ["SQL"], description: "",
};
const show = (description: string, isPro = true, user: { id: string; email: string } | null = null) =>
  render(<JobDetailView job={{ ...base, description }} candidate={null} user={user as any} isPro={isPro} isSaved={false} onSave={() => {}} onApply={() => {}} onBack={() => {}} />);
afterEach(cleanup);

describe("Education and Languages sections", () => {
  it("renders headed bullet lists as their own sections", () => {
    show("Requirements:\n- SQL\n\nEducation:\n- Bachelor's degree in a related field\n\nLanguages:\n- English (fluent)\n- German");
    const edu = screen.getByTestId("job-education-section");
    expect(within(edu).getByRole("heading", { name: "Education" })).toBeTruthy();
    expect(within(edu).getByText("Bachelor's degree in a related field")).toBeTruthy();
    const lang = screen.getByTestId("job-languages-section");
    expect(within(lang).getAllByRole("listitem").map((l) => l.textContent)).toEqual(["✓English (fluent)", "✓German"]);
  });
  it("shows neither section when the description has no headed list, even if it mentions a degree or a language", () => {
    show("We want someone with a degree and good English.\n\nRequirements:\n- SQL");
    expect(screen.queryByTestId("job-education-section")).toBeNull();
    expect(screen.queryByTestId("job-languages-section")).toBeNull();
  });
  it("an unheaded paragraph after the list does not bleed into it", () => {
    show("Education:\n- BSc\n\nWe are an equal opportunity employer.");
    expect(within(screen.getByTestId("job-education-section")).getAllByRole("listitem")).toHaveLength(1);
  });
  it("Free, guest and a failed Pro unlock never see the sections, even if a description is present", () => {
    const d = "Education:\n- BSc\n\nLanguages:\n- English";
    show(d, false, { id: "u", email: "free@example.invalid" });
    expect(screen.queryByTestId("job-education-section")).toBeNull();
    expect(screen.queryByTestId("job-languages-section")).toBeNull();
    cleanup();
    show(d, false, null);
    expect(screen.queryByTestId("job-education-section")).toBeNull();
    cleanup();
    render(<JobDetailView job={{ ...base, description: d, proUnlockError: { status: 403, message: "x" } } as any} candidate={null} user={null} isPro isSaved={false} onSave={() => {}} onApply={() => {}} onBack={() => {}} />);
    expect(screen.queryByTestId("job-education-section")).toBeNull();
  });
});
