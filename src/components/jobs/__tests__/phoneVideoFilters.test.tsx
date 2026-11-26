// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import PhoneVideoFilters from "../PhoneVideoFilters";
import type { JobFilterValues } from "../JobFilterBar";
const base: JobFilterValues = {
  location: "",
  category: "",
  level: "",
  jobType: "",
  workModel: "",
  datePosted: "",
  sort: "match",
  hidden: false,
};
beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: true });
});
afterEach(cleanup);
function setup(filters = base) {
  const onApply = vi.fn(),
    onClose = vi.fn();
  return {
    ...render(<PhoneVideoFilters isOpen filters={filters} onApply={onApply} onClose={onClose} />),
    onApply,
    onClose,
  };
}
describe("Actual phone Jobs filter contract", () => {
  it("keeps checkbox edits local and emits existing browse tokens only on Update", () => {
    const { onApply } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Basic Job Criteria/ }));
    fireEvent.click(screen.getByLabelText("Full-time"));
    fireEvent.click(screen.getByLabelText("Contract"));
    fireEvent.click(screen.getByLabelText("Remote"));
    fireEvent.click(screen.getByLabelText("Entry Level"));
    fireEvent.click(screen.getByLabelText("Past 3 days"));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(onApply).toHaveBeenCalledOnce();
    expect(onApply).toHaveBeenCalledWith({
      ...base,
      jobType: "full-time, contract",
      workModel: "remote",
      level: "entry",
      datePosted: "3d",
      salaryMin: "",
    });
  });
  it("discard close does not apply; reopening replaces draft with actual filters", () => {
    const { onApply, onClose, rerender } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Basic Job Criteria/ }));
    fireEvent.click(screen.getByLabelText("Full-time"));
    fireEvent.click(screen.getByLabelText("Close filter settings"));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    rerender(
      <PhoneVideoFilters isOpen={false} filters={base} onApply={onApply} onClose={onClose} />
    );
    rerender(<PhoneVideoFilters isOpen filters={base} onApply={onApply} onClose={onClose} />);
    expect(screen.getByLabelText("Full-time")).not.toBeChecked();
  });
  it("nested country search selection stays draft; Escape returns, second Escape closes", () => {
    const { onApply, onClose, container } = setup({ ...base, countryCode: "US" });
    fireEvent.click(screen.getByRole("button", { name: /Basic Job Criteria/ }));
    const buttons = container.querySelectorAll<HTMLButtonElement>(".cm-vf-group-body .cm-vf-add");
    fireEvent.click(buttons[0]);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "India" } });
    fireEvent.click(screen.getByRole("button", { name: "India" }));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Filter positions");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("Reset is local, clears stale unsupported industry/experience and preserves sort", () => {
    const { onApply } = setup({
      ...base,
      company: "Acme",
      industry: "health",
      experience: "2-5",
      sort: "newest",
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(onApply).toHaveBeenCalledWith({
      ...base,
      countryCode: "",
      salaryMin: "",
      sourceType: "",
      company: "",
      industry: "",
      experience: "",
      sort: "newest",
    });
  });
  it("one accordion only, unsupported dimensions are disclosures not interactive fake filters", () => {
    const { container } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Basic Job Criteria/ }));
    fireEvent.click(screen.getByRole("button", { name: /Company Insights/ }));
    expect(container.querySelectorAll("h3 button[aria-expanded=true]")).toHaveLength(1);
    expect(screen.queryByLabelText(/visa|sponsorship|radius|excluded titles/i)).toBeNull();
    expect(container.querySelector(".cm-vf-unavailable")?.textContent).toContain("Not available");
  });
  it("rejects invalid negative salary without applying", () => {
    const { onApply } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Compensation & Sponsorship/ }));
    fireEvent.change(screen.getByLabelText("Minimum annual salary USD"), {
      target: { value: "-10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("zero or more");
  });
});
