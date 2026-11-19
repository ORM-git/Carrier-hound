// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import JobFilterBar, { JobFilterValues } from "../JobFilterBar";

describe("JobFilterBar - Chip Labels and Unclipped Popovers", () => {
  const defaultFilters: JobFilterValues = {
    location: "",
    category: "",
    level: "",
    jobType: "",
    workModel: "",
    datePosted: "all",
    hidden: false,
    sort: "match",
  };

  const renderFilterBar = (overrideFilters?: Partial<JobFilterValues>) => {
    return render(
      <JobFilterBar
        filters={{ ...defaultFilters, ...overrideFilters }}
        onChange={vi.fn()}
        onClearAll={vi.fn()}
        activeCount={0}
        hiddenCount={0}
        onOpenAllFilters={vi.fn()}
        onOpenMobileFilters={vi.fn()}
        isMobileFiltersOpen={false}
        mobileFiltersTriggerRef={{ current: null }}
        hasConfirmedResume={false}
      />
    );
  };

  afterEach(() => {
    cleanup();
  });

  it("does not wrap chips inside an overflow-x-auto container that clips popovers", () => {
    const { container } = renderFilterBar();

    // The desktop filter bar container must NOT contain overflow-x-auto around the filter buttons
    const desktopFilterBar = container.querySelector(".hidden.md\\:flex");
    expect(desktopFilterBar).toBeTruthy();
    expect(desktopFilterBar?.querySelector(".overflow-x-auto")).toBeNull();
  });

  it("ensures filter chip buttons have whitespace-nowrap and shrink-0 so labels never wrap across lines", () => {
    renderFilterBar();

    const locationBtn = screen.getByLabelText(/location filter/i);
    expect(locationBtn.className).toContain("whitespace-nowrap");
    expect(locationBtn.className).toContain("shrink-0");

    const categoryBtn = screen.getByLabelText(/job category filter/i);
    expect(categoryBtn.className).toContain("whitespace-nowrap");
    expect(categoryBtn.className).toContain("shrink-0");

    const levelBtn = screen.getByLabelText(/level filter/i);
    expect(levelBtn.className).toContain("whitespace-nowrap");
    expect(levelBtn.className).toContain("shrink-0");

    const dateBtn = screen.getByLabelText(/date posted filter/i);
    expect(dateBtn.className).toContain("whitespace-nowrap");
    expect(dateBtn.className).toContain("shrink-0");
  });

  it("visibly opens the Location filter popover on click with accessible dialog semantics", () => {
    renderFilterBar();

    const locationBtn = screen.getByLabelText(/location filter/i);
    expect(screen.queryByRole("dialog", { name: /filter by location/i })).toBeNull();

    fireEvent.click(locationBtn);
    expect(screen.getByRole("dialog", { name: /filter by location/i })).toBeInTheDocument();
  });

  it("visibly opens the Job Category filter popover on click", () => {
    renderFilterBar();

    const categoryBtn = screen.getByLabelText(/job category filter/i);
    fireEvent.click(categoryBtn);
    expect(screen.getByRole("dialog", { name: /filter by job category/i })).toBeInTheDocument();
  });

  it("visibly opens the Level filter popover on click", () => {
    renderFilterBar();

    const levelBtn = screen.getByLabelText(/level filter/i);
    fireEvent.click(levelBtn);
    expect(screen.getByRole("dialog", { name: /filter by experience level/i })).toBeInTheDocument();
  });

  it("visibly opens the Date Posted filter popover on click", () => {
    renderFilterBar();

    const dateBtn = screen.getByLabelText(/date posted filter/i);
    fireEvent.click(dateBtn);
    expect(screen.getByRole("dialog", { name: /filter by date posted/i })).toBeInTheDocument();
  });

  it("visibly opens the Job Type filter popover on click", () => {
    renderFilterBar();

    const jobTypeBtn = screen.getByLabelText(/job type filter/i);
    fireEvent.click(jobTypeBtn);
    expect(screen.getByRole("dialog", { name: /filter by job type/i })).toBeInTheDocument();
  });

  it("visibly opens the Work Model filter popover on click", () => {
    renderFilterBar();

    const workModelBtn = screen.getByLabelText(/work model filter/i);
    fireEvent.click(workModelBtn);
    expect(screen.getByRole("dialog", { name: /filter by work model/i })).toBeInTheDocument();
  });

  it("visibly opens the Years of Experience filter popover on click", () => {
    renderFilterBar();

    const expBtn = screen.getByLabelText(/experience filter/i);
    fireEvent.click(expBtn);
    expect(screen.getByRole("dialog", { name: /filter by experience/i })).toBeInTheDocument();
  });

  it("verifies two-row desktop layout structure and pinned sort", () => {
    const { container } = renderFilterBar();

    const desktopFilterBar = container.querySelector(".hidden.md\\:flex");
    expect(desktopFilterBar).toBeTruthy();

    // Row 1 container must be flex items-start justify-between without outer flex-wrap
    const row1Container = desktopFilterBar?.children[0];
    expect(row1Container?.className).toContain("flex");
    expect(row1Container?.className).toContain("items-start");
    expect(row1Container?.className).toContain("justify-between");
    expect(row1Container?.className).not.toContain("flex-wrap");

    // Primary chip container must absorb width deficits via flex-1 min-w-0 flex-wrap
    const primaryChipGroup = row1Container?.children[0];
    expect(primaryChipGroup?.className).toContain("flex-1");
    expect(primaryChipGroup?.className).toContain("min-w-0");
    expect(primaryChipGroup?.className).toContain("flex-wrap");

    // Sort control must be pinned with shrink-0
    const sortContainer = row1Container?.children[1];
    expect(sortContainer?.className).toContain("shrink-0");

    // Row 2 container must be flex flex-wrap items-center
    const row2Container = desktopFilterBar?.children[1];
    expect(row2Container?.className).toContain("flex");
    expect(row2Container?.className).toContain("flex-wrap");
    expect(row2Container?.className).toContain("items-center");

    // Secondary filters (min salary, source, company) are hidden below 2xl
    const salaryChip = row2Container?.querySelector('[class*="2xl:block"]');
    expect(salaryChip).toBeTruthy();
  });

  it("visibly opens the Sort dropdown on click", () => {
    renderFilterBar();

    const sortBtns = screen.getAllByLabelText(/sort by/i);
    // Desktop sort button
    fireEvent.click(sortBtns[1] || sortBtns[0]);
    expect(screen.getByText(/recommended \(match\)/i)).toBeInTheDocument();
  });
});
