// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import AllFiltersDrawer from "../AllFiltersDrawer";
import type { JobFilterValues } from "../JobFilterBar";

const base: JobFilterValues = { location: "", category: "", level: "", jobType: "", workModel: "", datePosted: "all", hidden: false, sort: "match" };
const open = (over: Partial<JobFilterValues> = {}, onApply = vi.fn(), onClose = vi.fn()) => {
  render(<AllFiltersDrawer isOpen onClose={onClose} filters={{ ...base, ...over }} onApply={onApply} onResetAll={vi.fn()} activeCount={0} />);
  return { onApply, onClose };
};
const applied = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[0][0] as JobFilterValues;
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("All Filters drawer (desktop, five sections)", () => {
  it("shows the five sections in the rail and one scrolling form with a heading for each", () => {
    open();
    const nav = screen.getByRole("navigation", { name: "Filter sections" });
    for (const t of ["Basic Job Criteria", "Compensation & Sponsorship", "Areas of Interests", "Company Insights", "Preferences & Hidden"]) expect(within(nav).getByText(t)).toBeTruthy();
    for (const t of ["Basic Job Criteria", "Compensation & Sponsorship", "Areas of Interests", "Company Insights", "Preferences & Hidden"]) expect(screen.getAllByRole("heading", { name: t }).length).toBe(1);
    expect(within(nav).getByText(/Applying for Intern\/New Grad\?/)).toBeTruthy();
  });

  it("Confirm applies exactly what was picked; closing without Confirm applies nothing", () => {
    const { onApply, onClose } = open();
    fireEvent.click(screen.getByLabelText("Full-time"));
    fireEvent.click(screen.getByLabelText("Hybrid"));
    fireEvent.click(screen.getByLabelText("Director / Executive"));
    fireEvent.click(screen.getByLabelText("Past 3 days"));
    fireEvent.click(screen.getByRole("button", { name: "India" }));
    fireEvent.change(screen.getByLabelText("City or specific area"), { target: { value: "Pune" } });
    fireEvent.change(screen.getByLabelText("Company"), { target: { value: "Stripe" } });
    fireEvent.click(screen.getByRole("button", { name: "Employer" }));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm"));
    const a = applied(onApply);
    expect(a).toMatchObject({ jobType: "full-time", workModel: "hybrid", level: "director", datePosted: "3d", countryCode: "IN", location: "Pune", company: "Stripe", sourceType: "direct" });
    expect(onClose).toHaveBeenCalled();
  });

  it("close button and Escape close without applying", () => {
    const { onApply, onClose } = open();
    fireEvent.click(screen.getByLabelText("Close all filters drawer"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("salary slider and Open to all drive salaryMin with the same preset values as before", () => {
    const { onApply } = open();
    const slider = screen.getByLabelText("Minimum annual salary") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "3" } });
    expect(screen.getAllByText(/\$100k\+/).length).toBeGreaterThan(0);
    const toggle = screen.getByRole("switch", { name: "Open to all salaries" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.change(slider, { target: { value: "5" } });
    fireEvent.click(screen.getByText("Confirm"));
    expect(applied(onApply).salaryMin).toBe("150000");
  });

  it("date posted Clear All empties the window; Reset All clears every control", () => {
    const { onApply } = open({ datePosted: "7d", jobType: "contract", salaryMin: "80000", company: "Acme", hidden: true });
    fireEvent.click(screen.getByLabelText("Clear date posted"));
    fireEvent.click(screen.getByText("Reset All"));
    fireEvent.click(screen.getByText("Confirm"));
    expect(applied(onApply)).toMatchObject({ datePosted: "", jobType: "", salaryMin: "", company: "", hidden: false });
  });

  it("hidden-positions switch is wired and chips show the first three plus a +N Filters count", () => {
    const { onApply } = open({ jobType: "full-time", workModel: "remote", level: "entry,senior", datePosted: "24h" });
    expect(screen.getByText("+2 Filters")).toBeTruthy();
    expect(screen.getByText("All Filters").parentElement!.textContent).toContain("5");
    fireEvent.click(screen.getByRole("switch", { name: "View Hidden Positions toggle" }));
    fireEvent.click(screen.getByText("Confirm"));
    expect(applied(onApply).hidden).toBe(true);
  });

  it("controls without a data backing are honest notes, not enabled controls", () => {
    open();
    expect(screen.getByText(/Visa sponsorship .* not available in this drawer yet/)).toBeTruthy();
    expect(screen.getByText(/Industry, skill and role-type filters are not available in this drawer yet/)).toBeTruthy();
    expect(screen.getByText(/Company stage and staffing-agency exclusion are not available yet/)).toBeTruthy();
    expect(screen.queryByLabelText(/H1B/i)).toBeNull();
    expect(screen.queryByLabelText(/Add Excluded Title/)).toBeNull();
  });

  it("title and company lists appear only when the owner flag is on, and Confirm carries them", () => {
    vi.stubEnv("NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "true");
    const { onApply } = open();
    fireEvent.click(screen.getByText("Excluded Title"));
    fireEvent.change(screen.getByLabelText("Add Excluded Title"), { target: { value: "Intern" } });
    fireEvent.submit(screen.getByLabelText("Add Excluded Title").closest("form")!);
    fireEvent.change(screen.getByLabelText("Add Exclude Company"), { target: { value: "Acme" } });
    fireEvent.submit(screen.getByLabelText("Add Exclude Company").closest("form")!);
    fireEvent.click(screen.getByText("Confirm"));
    expect(applied(onApply)).toMatchObject({ excludedTitles: ["Intern"], excludedCompanies: ["Acme"] });
  });

  it("survives closed -> open -> close -> reopen on one mounted instance (hook order stable)", () => {
    const props = { onClose: vi.fn(), onApply: vi.fn(), onResetAll: vi.fn(), activeCount: 0 };
    const f = { ...base };
    const { rerender } = render(<AllFiltersDrawer isOpen={false} filters={f} {...props} />);
    expect(screen.queryByText("Confirm")).toBeNull();
    rerender(<AllFiltersDrawer isOpen filters={f} {...props} />);
    expect(screen.getByText("Confirm")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Company Insights/ }));
    rerender(<AllFiltersDrawer isOpen={false} filters={f} {...props} />);
    expect(screen.queryByText("Confirm")).toBeNull();
    rerender(<AllFiltersDrawer isOpen filters={f} {...props} />);
    expect(screen.getByText("Confirm")).toBeTruthy();
  });

  it("moves focus into the dialog on open, traps the first Tab, and restores focus on every close path", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const ref = { current: trigger };
    const props = { onClose: vi.fn(), onApply: vi.fn(), onResetAll: vi.fn(), activeCount: 0, triggerRef: ref };
    const { rerender } = render(<AllFiltersDrawer isOpen={false} filters={base} {...props} />);
    rerender(<AllFiltersDrawer isOpen filters={base} {...props} />);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    // focus escaped to the background trigger: first Tab must pull it back inside
    trigger.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    // parent-driven close (covers Confirm, Esc, X, backdrop) restores focus
    rerender(<AllFiltersDrawer isOpen={false} filters={base} {...props} />);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("measures the panel with a ResizeObserver and window resize, and disconnects/removes both on close and unmount", () => {
    const disconnect = vi.fn();
    const observe = vi.fn();
    const RO = vi.fn(function (this: any) { this.observe = observe; this.disconnect = disconnect; this.unobserve = vi.fn(); });
    vi.stubGlobal("ResizeObserver", RO);
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const props = { onClose: vi.fn(), filters: base, onApply: vi.fn(), onResetAll: vi.fn(), activeCount: 0 };
    const { rerender, unmount } = render(<AllFiltersDrawer isOpen {...props} />);
    expect(RO).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);
    const resizeAdds = add.mock.calls.filter((c) => c[0] === "resize").length;
    expect(resizeAdds).toBe(1);
    rerender(<AllFiltersDrawer isOpen={false} {...props} />);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls.filter((c) => c[0] === "resize").length).toBe(1);
    rerender(<AllFiltersDrawer isOpen {...props} />);
    expect(RO).toHaveBeenCalledTimes(2);
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls.filter((c) => c[0] === "resize").length).toBe(2);
    add.mockRestore();
    remove.mockRestore();
    vi.unstubAllGlobals();
  });

  it("the dim backdrop closes the drawer on click, is presentation-only (not a control), and Escape and the close button still close it", () => {
    const { onClose } = open();
    const backdrop = document.querySelector('div[aria-hidden="true"].fixed.inset-0') as HTMLElement;
    expect(backdrop.getAttribute("role")).toBe("presentation");
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
