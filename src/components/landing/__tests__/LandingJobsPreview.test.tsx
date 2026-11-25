// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LandingJobsPreview from "../LandingJobsPreview";
vi.mock("next/link", () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("actual-card landing preview", () => {
  it("starts arcs at zero, fills to the owner-selected values, and cleans its animation timer", () => {
    const view = render(<LandingJobsPreview />);
    expect(view.container.querySelectorAll('[aria-label="Preview score: 0%, not your personal match"]')).toHaveLength(2);
    act(() => vi.advanceTimersByTime(80));
    expect(view.container.querySelector('[aria-label="Preview score: 95%, not your personal match"]')).not.toBeNull();
    view.unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it("uses final values immediately for reduced motion", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const { container } = render(<LandingJobsPreview />);
    expect(container.querySelector('[aria-label="Preview score: 90%, not your personal match"]')).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("renders screenshot-grounded full metadata through the shared Jobs renderer with explicitly illustrative owner-selected percentages", () => {
    const { container } = render(<LandingJobsPreview />);
    expect(container.querySelectorAll('[data-testid="landing-job-card"]')).toHaveLength(2);
    for (const text of ["PlanetScale", "Docker", "Video Production Lead", "Senior Principal Forward Deployed Engineer", "Remote US", "United States", "Staff / Lead"]) expect(container.textContent).toContain(text);
    expect(container.querySelectorAll('img[src="/landing-companies/planetscale.svg"]')).toHaveLength(2);
    expect(container.querySelectorAll('img[src="/landing-companies/docker.svg"]')).toHaveLength(2);
    expect(container.textContent).not.toMatch(/Early applicant|Direct feed|hours ago|Demo|\$\d/);
    expect(container.textContent).toContain("sample scores");
    act(() => vi.advanceTimersByTime(80));
    expect(container.querySelector('[aria-label="Preview score: 90%, not your personal match"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Preview score: 95%, not your personal match"]')).not.toBeNull();
  });
  it("routes preview actions to Jobs instead of pretending to apply/save to a specific live vacancy", () => {
    const { container } = render(<LandingJobsPreview />);
    const actions = Array.from(container.querySelectorAll('[aria-label="Open Jobs to save roles"], [aria-label="Browse job options"]'));
    expect(actions).toHaveLength(8);
    expect(actions.every(el => el.getAttribute("href") === "/jobs")).toBe(true);
    expect(screen.getAllByText("Browse jobs")).toHaveLength(4);
    expect(screen.getAllByText("Apply")).toHaveLength(4);
    expect(screen.getAllByText("Apply")[0].className).toBe("sm:hidden");
    expect(container.querySelector("#landing-preview-heading")?.className).toContain("hidden sm:block");
    expect(screen.getAllByText("Jobs preview")[0].className).toBe("hidden sm:inline");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
  it("keeps the faded second preview inert and hidden from assistive technology", () => {
    const { container } = render(<LandingJobsPreview />);
    expect(container.querySelector('.peek')?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector('.peek')?.hasAttribute("inert")).toBe(true);
    expect(container.querySelector('article')?.closest('[aria-hidden="true"]')).toBeNull();
  });
});
