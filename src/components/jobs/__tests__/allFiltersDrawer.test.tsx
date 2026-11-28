// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import AllFiltersDrawer from "../AllFiltersDrawer";
import type { JobFilterValues } from "../JobFilterBar";

const base: JobFilterValues = { location: "", category: "", level: "", jobType: "", workModel: "", datePosted: "all", hidden: false, sort: "match" };
const open = (over: Partial<JobFilterValues> = {}, onApply = vi.fn(), onClose = vi.fn(), extra: Partial<React.ComponentProps<typeof AllFiltersDrawer>> = {}) => {
  render(<AllFiltersDrawer isOpen onClose={onClose} filters={{ ...base, ...over }} onApply={onApply} onResetAll={vi.fn()} activeCount={0} {...extra} />);
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

  const ready = { ready: true, tabSupported: true, saved: null };

  it("years control is disabled with a reason when the page gives no readiness, wrong tab, or still checking; Confirm then keeps the page choice (undefined)", () => {
    for (const [yc, text] of [
      [undefined, /not available right now/],
      [{ ready: false, tabSupported: true }, /not available right now/],
      [{ ready: true, tabSupported: false }, /Recommended feed only/],
      [{ ready: false, tabSupported: true, checking: true }, /Checking whether required years/],
      [{ ready: true, tabSupported: true, checking: true }, /Checking whether required years/], // stale-true while rechecking
    ] as const) {
      cleanup();
      const { onApply } = open({ requiredYears: { mode: "range", min: 1, max: 3 } }, vi.fn(), vi.fn(), { yearsControl: yc as any });
      expect(screen.getByText(text)).toBeTruthy();
      expect(screen.queryByLabelText("Min years")).toBeNull();
      expect(screen.queryByRole("radiogroup", { name: "Required years mode" })).toBeNull();
      fireEvent.click(screen.getByText("Confirm"));
      expect(applied(onApply).requiredYears).toBeUndefined();
    }
  });

  it("years control (ready): Saved range / Any / range are distinct, Any is explicit, saved range is shown honestly", () => {
    const a = vi.fn();
    open({ requiredYears: { mode: "inherit" } }, a, vi.fn(), { yearsControl: { ...ready, saved: { min: 2, max: 6 } } });
    expect(screen.getByText("Using your saved range: 2-6 yrs")).toBeTruthy();
    expect((screen.getByLabelText("Saved range") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText("Any"));
    expect(screen.getByText("Any years required")).toBeTruthy();
    fireEvent.click(screen.getByText("Confirm"));
    expect(applied(a).requiredYears).toEqual({ mode: "any" });
    cleanup();
    const b = vi.fn();
    open({}, b, vi.fn(), { yearsControl: ready });
    expect(screen.getByText(/You have no saved range, so no years limit applies/)).toBeTruthy();
    fireEvent.click(screen.getByText("Confirm"));
    expect(applied(b).requiredYears).toEqual({ mode: "inherit" });
  });

  it("years range: Confirm sends the normalized range; min<=max kept; empty range is inherit; 0 with no max is Any; Reset goes to Saved range", () => {
    const a = vi.fn();
    open({}, a, vi.fn(), { yearsControl: ready });
    fireEvent.click(screen.getByLabelText("Set a range"));
    const min = screen.getByLabelText("Min years") as HTMLInputElement;
    const max = screen.getByLabelText("Max years") as HTMLInputElement;
    fireEvent.change(min, { target: { value: "2" } });
    fireEvent.change(max, { target: { value: "5" } });
    expect(screen.getByText("2-5 yrs required")).toBeTruthy();
    fireEvent.change(min, { target: { value: "9" } });
    expect(max.value).toBe("9");
    fireEvent.change(max, { target: { value: "4" } });
    expect(min.value).toBe("4");
    fireEvent.change(min, { target: { value: "2" } });
    fireEvent.click(screen.getByText("Confirm"));
    expect(applied(a).requiredYears).toEqual({ mode: "range", min: 2, max: 4 });
    cleanup();
    const e = vi.fn();
    open({}, e, vi.fn(), { yearsControl: ready });
    fireEvent.click(screen.getByLabelText("Set a range"));
    fireEvent.click(screen.getByText("Confirm"));
    expect(applied(e).requiredYears).toEqual({ mode: "inherit" });
    cleanup();
    const z = vi.fn();
    open({}, z, vi.fn(), { yearsControl: ready });
    fireEvent.click(screen.getByLabelText("Set a range"));
    fireEvent.change(screen.getByLabelText("Min years"), { target: { value: "0" } });
    fireEvent.click(screen.getByText("Confirm"));
    expect(applied(z).requiredYears).toEqual({ mode: "any" });
    cleanup();
    const r = vi.fn();
    open({ requiredYears: { mode: "range", min: 1, max: 3 } }, r, vi.fn(), { yearsControl: ready });
    fireEvent.click(screen.getByText("Reset All"));
    fireEvent.click(screen.getByText("Confirm"));
    expect(applied(r).requiredYears).toEqual({ mode: "inherit" });
  });

  it("asks the page to recheck years readiness every time the drawer opens", () => {
    const recheck = vi.fn();
    const props = { onClose: vi.fn(), onApply: vi.fn(), onResetAll: vi.fn(), activeCount: 0, onYearsRecheck: recheck };
    const { rerender } = render(<AllFiltersDrawer isOpen={false} filters={base} {...props} />);
    expect(recheck).not.toHaveBeenCalled();
    rerender(<AllFiltersDrawer isOpen filters={base} {...props} />);
    rerender(<AllFiltersDrawer isOpen={false} filters={base} {...props} />);
    rerender(<AllFiltersDrawer isOpen filters={base} {...props} />);
    expect(recheck).toHaveBeenCalledTimes(2);
  });

  it("ready:true + checking:true (stale-true reopen): no chip, no control, Confirm sends undefined, Reset does not touch years", () => {
    const a = vi.fn();
    open({ requiredYears: { mode: "range", min: 2, max: 5 }, level: "entry" }, a, vi.fn(), { yearsControl: { ready: true, tabSupported: true, checking: true, saved: null } });
    expect(screen.queryByText("2-5 yrs required")).toBeNull();
    expect(screen.queryByLabelText("Min years")).toBeNull();
    fireEvent.click(screen.getByText("Confirm"));
    expect(applied(a).requiredYears).toBeUndefined();
    cleanup();
    const r = vi.fn();
    open({ requiredYears: { mode: "range", min: 2, max: 5 } }, r, vi.fn(), { yearsControl: { ready: true, tabSupported: true, checking: true } });
    fireEvent.click(screen.getByText("Reset All"));
    fireEvent.click(screen.getByText("Confirm"));
    expect(applied(r).requiredYears).toBeUndefined();
  });

  it("range inputs have visible Min years / Max years labels", () => {
    open({}, vi.fn(), vi.fn(), { yearsControl: { ready: true, tabSupported: true } });
    fireEvent.click(screen.getByLabelText("Set a range"));
    expect(screen.getByText("Min years")).toBeTruthy();
    expect(screen.getByText("Max years")).toBeTruthy();
    expect(screen.getByLabelText("Min years")).toBeTruthy();
    expect(screen.getByLabelText("Max years")).toBeTruthy();
  });

  describe("apply result contract", () => {
    const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
    it("void and true close (sync for void); false and a rejected/throwing apply keep the drawer open with the draft", async () => {
      let r = open({}, vi.fn(() => undefined));
      fireEvent.click(screen.getByText("Confirm"));
      expect(r.onClose).toHaveBeenCalledTimes(1);
      cleanup();
      r = open({}, vi.fn(() => true));
      fireEvent.click(screen.getByText("Confirm"));
      expect(r.onClose).toHaveBeenCalledTimes(1);
      cleanup();
      r = open({}, vi.fn(() => false));
      fireEvent.click(screen.getByLabelText("Full-time"));
      fireEvent.click(screen.getByText("Confirm"));
      await tick();
      expect(r.onClose).not.toHaveBeenCalled();
      expect((screen.getByLabelText("Full-time") as HTMLInputElement).checked).toBe(true);
      cleanup();
      r = open({}, vi.fn(() => { throw new Error("x"); }));
      fireEvent.click(screen.getByText("Confirm"));
      await tick();
      expect(r.onClose).not.toHaveBeenCalled();
    });
    it("a Confirm that settles after the drawer was closed, or closed and reopened, cannot close or lock the new session", async () => {
      const resolvers: Array<(v: boolean) => void> = [];
      const onApply = vi.fn(() => new Promise<boolean>((r) => { resolvers.push(r); }));
      const onClose = vi.fn();
      const props = { onClose, filters: base, onApply, onResetAll: vi.fn(), activeCount: 0 };
      const { rerender } = render(<AllFiltersDrawer isOpen {...props} />);
      fireEvent.click(screen.getByText("Confirm"));
      rerender(<AllFiltersDrawer isOpen={false} {...props} />);
      rerender(<AllFiltersDrawer isOpen {...props} />);
      // new session is not locked by the old pending Confirm
      fireEvent.click(screen.getByText("Confirm"));
      expect(onApply).toHaveBeenCalledTimes(2);
      resolvers[0](true); // stale true from the previous session
      await tick();
      expect(onClose).not.toHaveBeenCalled();
      resolvers[1](true); // the current session's own answer still closes
      await tick();
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    it("a stale rejection from an old session does not unlock a pending Confirm in the new session (double click stays one apply)", async () => {
      const resolvers: Array<(v: boolean) => void> = [];
      const onApply = vi.fn(() => new Promise<boolean>((r) => { resolvers.push(r); }));
      const props = { onClose: vi.fn(), filters: base, onApply, onResetAll: vi.fn(), activeCount: 0 };
      const { rerender } = render(<AllFiltersDrawer isOpen {...props} />);
      fireEvent.click(screen.getByText("Confirm"));
      rerender(<AllFiltersDrawer isOpen={false} {...props} />);
      rerender(<AllFiltersDrawer isOpen {...props} />);
      fireEvent.click(screen.getByText("Confirm"));
      resolvers[0](false);
      await tick();
      fireEvent.click(screen.getByText("Confirm"));
      expect(onApply).toHaveBeenCalledTimes(2);
    });
    it("async apply: closes only after it resolves non-false; false keeps it open and a second Confirm is allowed; double click is ignored while pending", async () => {
      let res!: (v: boolean) => void;
      const onApply = vi.fn(() => new Promise<boolean>((r) => { res = r; }));
      const { onClose } = open({}, onApply);
      fireEvent.click(screen.getByText("Confirm"));
      fireEvent.click(screen.getByText("Confirm"));
      expect(onApply).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
      res(false);
      await tick();
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText("Confirm"));
      expect(onApply).toHaveBeenCalledTimes(2);
      res(true);
      await tick();
      expect(onClose).toHaveBeenCalledTimes(1);
    });
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
