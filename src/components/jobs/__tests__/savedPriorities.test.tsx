// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import AllFiltersDrawer from "../AllFiltersDrawer";
import SavedPrioritiesNote from "../SavedPrioritiesNote";
import type { JobFilterValues } from "../JobFilterBar";
import { savedPrioritiesSummary } from "@/lib/preferences/savedControlDisplay";

const f: JobFilterValues = { location: "", category: "", level: "", jobType: "", workModel: "", datePosted: "all", hidden: false, sort: "match" };
afterEach(() => cleanup());

describe("saved priorities context", () => {
  it("summary names country, first type and work model with +N, never a filter", () => {
    expect(savedPrioritiesSummary({ countryCode: "IN", jobType: "full-time,contract", workModel: "remote,hybrid" })).toBe("Country IN, full-time +1, Remote +1");
    expect(savedPrioritiesSummary({})).toBe("");
  });
  it("note is persistent text that says ranking only and other jobs remain, and edits saved priorities", () => {
    const onEdit = vi.fn();
    render(<SavedPrioritiesNote where="bar" summary="Country IN" onEdit={onEdit} />);
    expect(screen.getByTestId("saved-priorities-note-bar").textContent).toMatch(/rank your feed first/i);
    expect(screen.getByTestId("saved-priorities-note-bar").textContent).toMatch(/Other relevant jobs still show/i);
    fireEvent.click(screen.getByText("Edit saved priorities"));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
  it("drawer shows the context but Confirm applies the untouched strict draft (no country copied in)", () => {
    const onApply = vi.fn();
    const onEdit = vi.fn();
    render(
      <AllFiltersDrawer isOpen onClose={vi.fn()} filters={f} onApply={onApply} onResetAll={vi.fn()} activeCount={0}
        savedPriorities={{ summary: "Country IN, Remote", onEdit }} />
    );
    expect(screen.getByTestId("saved-priorities-note-drawer").textContent).toMatch(/Country IN, Remote/);
    fireEvent.click(screen.getByText("Edit saved priorities"));
    expect(onEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm"));
    const applied = onApply.mock.calls[0][0] as JobFilterValues;
    expect(applied.countryCode ?? "").toBe("");
    expect(applied.jobType).toBe("");
    expect(applied.workModel).toBe("");
  });
  it("drawer without saved priorities shows no note", () => {
    render(<AllFiltersDrawer isOpen onClose={vi.fn()} filters={f} onApply={vi.fn()} onResetAll={vi.fn()} activeCount={0} />);
    expect(screen.queryByTestId("saved-priorities-note-drawer")).toBeNull();
  });
});
