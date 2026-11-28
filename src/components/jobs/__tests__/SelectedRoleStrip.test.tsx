// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import SelectedRoleStrip from "../SelectedRoleStrip";

// jsdom has no layout, so widths are supplied: every chip is 120 px wide, the toggle 44 px, the strip 330 px.
// Row math (gap 6): 2 chips per row (120+6+120=246, a third would be 372), so two rows hold 4 chips; with a toggle, row 2 is 120+6+120+6+44=296 <= 330, so 4 chips + toggle still fit.
let roCb: (() => void) | null = null;
let stripWidth = 330;
let chipW = 120;
let observed = 0;
let disconnected = 0;
beforeEach(() => {
  stripWidth = 330; chipW = 120; roCb = null; observed = 0; disconnected = 0;
  vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { roCb = cb; } observe() { observed++; } disconnect() { disconnected++; } });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return stripWidth; } });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute("data-measure-toggle")) return 44;
      if (this.hasAttribute("data-measure-chip")) return chipW;
      return 0;
    },
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (HTMLElement.prototype as any).clientWidth; delete (HTMLElement.prototype as any).offsetWidth; });

const names = (n: number) => Array.from({ length: n }, (_, i) => `Role ${i + 1}`);
const chipsShown = () => Array.from(document.querySelectorAll("[data-role-chip]")).map((e) => e.getAttribute("data-role-chip"));

describe("SelectedRoleStrip", () => {
  it("renders nothing for no roles", () => {
    const { container } = render(<SelectedRoleStrip roles={[]} onRemove={() => {}} />);
    expect(container.querySelector("[aria-label='Selected job functions']")).toBeNull();
  });
  it("shows all chips and no toggle when they fit in two rows", () => {
    render(<SelectedRoleStrip roles={names(4)} onRemove={() => {}} />);
    expect(chipsShown()).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
  });
  it("collapses to two rows with a dynamic +N that fits row 2, then expands and shows less", () => {
    render(<SelectedRoleStrip roles={names(7)} onRemove={() => {}} />);
    expect(chipsShown()).toEqual(["Role 1", "Role 2", "Role 3", "Role 4"]);
    const more = screen.getByRole("button", { name: "Show 3 more selected job functions" });
    expect(more.textContent).toBe("+3");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(chipsShown()).toHaveLength(7);
    const less = screen.getByRole("button", { name: "Show less" });
    expect(less.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(less);
    expect(chipsShown()).toHaveLength(4);
  });
  it("removing a chip recomputes N, and the toggle disappears when everything fits", () => {
    const { rerender } = render(<SelectedRoleStrip roles={names(5)} onRemove={() => {}} />);
    expect(screen.getByRole("button", { name: "Show 1 more selected job functions" })).toBeTruthy();
    rerender(<SelectedRoleStrip roles={names(4)} onRemove={() => {}} />);
    expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
    expect(chipsShown()).toHaveLength(4);
  });
  it("recomputes when the strip is resized (rotate/resize): wider shows more, narrower shows fewer", () => {
    render(<SelectedRoleStrip roles={names(7)} onRemove={() => {}} />);
    expect(chipsShown()).toHaveLength(4);
    stripWidth = 520; // 3 chips per row (120*3+12=372; 4 would be 498 <= 520 so 4 per row), 2 rows hold 8
    act(() => { roCb?.(); });
    expect(chipsShown()).toHaveLength(7);
    expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
    stripWidth = 250; // 2 chips per row would need 246 <= 250, 1 row of 2 + toggle on row 2
    act(() => { roCb?.(); });
    expect(chipsShown()).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Show 4 more selected job functions" })).toBeTruthy();
  });
  it("observes its own width and stops observing on unmount", () => {
    const { unmount } = render(<SelectedRoleStrip roles={names(7)} onRemove={() => {}} />);
    expect(observed).toBe(1);
    unmount();
    expect(disconnected).toBe(1);
  });
  it("starts empty, then roles are added, removed and added again: always measured, observer attached exactly once", () => {
    const seven = names(7);
    const { rerender, container } = render(<SelectedRoleStrip roles={[]} onRemove={() => {}} />);
    expect(container.querySelector("[aria-label='Selected job functions']")).toBeNull();
    rerender(<SelectedRoleStrip roles={seven} onRemove={() => {}} />);
    expect(chipsShown()).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Show 3 more selected job functions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show 3 more selected job functions" }));
    expect(chipsShown()).toHaveLength(7);
    rerender(<SelectedRoleStrip roles={[]} onRemove={() => {}} />);
    expect(chipsShown()).toHaveLength(0);
    rerender(<SelectedRoleStrip roles={seven} onRemove={() => {}} />);
    expect(chipsShown()).toHaveLength(4); // expanded state was reset while empty
    expect(screen.getByRole("button", { name: "Show 3 more selected job functions" })).toBeTruthy();
    expect(observed).toBe(1);
    // a resize after the re-add is still seen
    stripWidth = 520;
    act(() => { roCb?.(); });
    expect(chipsShown()).toHaveLength(7);
  });
  it("re-measures when web fonts finish loading even though the strip width is unchanged", async () => {
    let fire: (() => void) | null = null;
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((r) => { resolveReady = r; });
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready, addEventListener: (_: string, cb: () => void) => { fire = cb; }, removeEventListener: () => { fire = null; } } });
    render(<SelectedRoleStrip roles={names(7)} onRemove={() => {}} />);
    expect(chipsShown()).toHaveLength(4);
    chipW = 90; // the real (narrower) font arrives: 3 per row (90*3+12=282 <= 330), 2 rows hold 6, 7 needs the toggle
    await act(async () => { resolveReady(); await ready; });
    expect(chipsShown()).toHaveLength(5); // row 2: 2 chips + toggle (90+6+90+6+44=236)... 3 chips + toggle = 282+6+44 = 332 > 330
    chipW = 60;
    act(() => { fire?.(); });
    expect(chipsShown()).toHaveLength(7);
    expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
    delete (document as any).fonts;
  });
  it("keyboard: the toggle keeps focus across expand and collapse (one stable element)", () => {
    render(<SelectedRoleStrip roles={names(7)} onRemove={() => {}} />);
    const more = screen.getByRole("button", { name: "Show 3 more selected job functions" });
    more.focus();
    fireEvent.click(more);
    const less = screen.getByRole("button", { name: "Show less" });
    expect(less).toBe(more);
    expect(document.activeElement).toBe(less);
    fireEvent.click(less);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show 3 more selected job functions" }));
  });
  it("removing the focused chip moves focus to the chip that takes its place, the previous one at the end, and the strip when empty", () => {
    function Harness({ initial }: { initial: string[] }) {
      const [roles, setRoles] = React.useState(initial);
      return <SelectedRoleStrip roles={roles} onRemove={(r) => setRoles((x) => x.filter((y) => y !== r))} />;
    }
    render(<Harness initial={names(4)} />);
    const r2 = screen.getByRole("button", { name: "Remove Role 2" });
    r2.focus();
    fireEvent.click(r2);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Role 3" }));
    const r4 = screen.getByRole("button", { name: "Remove Role 4" });
    r4.focus();
    fireEvent.click(r4);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Role 3" }));
    screen.getByRole("button", { name: "Remove Role 1" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Remove Role 1" }));
    const last = screen.getByRole("button", { name: "Remove Role 3" });
    expect(document.activeElement).toBe(last);
    last.focus();
    fireEvent.click(last);
    expect(document.activeElement).not.toBe(document.body);
  });
  it("removing a mouse-clicked chip (not focused) does not steal focus", () => {
    function Harness() {
      const [roles, setRoles] = React.useState(names(3));
      return (<div><input aria-label="other" /><SelectedRoleStrip roles={roles} onRemove={(r) => setRoles((x) => x.filter((y) => y !== r))} /></div>);
    }
    render(<Harness />);
    const other = screen.getByLabelText("other");
    other.focus();
    fireEvent.click(screen.getByRole("button", { name: "Remove Role 1" }));
    expect(document.activeElement).toBe(other);
  });
  it("a focused toggle that disappears because the list now fits hands focus to a chip control", () => {
    function Harness() {
      const [roles, setRoles] = React.useState(names(5));
      return (<div><button onClick={() => setRoles(names(4))}>shrink</button><SelectedRoleStrip roles={roles} onRemove={() => {}} /></div>);
    }
    render(<Harness />);
    const more = screen.getByRole("button", { name: "Show 1 more selected job functions" });
    more.focus();
    fireEvent.click(screen.getByText("shrink"));
    expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toMatch(/^Remove /);
  });
  it("remove button calls onRemove with the role and is labelled", () => {
    const onRemove = vi.fn();
    render(<SelectedRoleStrip roles={names(2)} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Role 2" }));
    expect(onRemove).toHaveBeenCalledWith("Role 2");
  });
  it("expanded strip scrolls inside itself (never grows over the search box) and keeps the same label", () => {
    render(<SelectedRoleStrip roles={names(9)} onRemove={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Show 5 more/ }));
    const strip = screen.getByLabelText("Selected job functions");
    expect(strip.className).toContain("overflow-y-auto");
    expect(strip.getAttribute("data-expanded")).toBe("true");
  });
  it("does not render the measuring copy to assistive tech", () => {
    const { container } = render(<SelectedRoleStrip roles={names(3)} onRemove={() => {}} />);
    expect(container.querySelector("[aria-hidden='true'][class*='invisible']")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Remove/ })).toHaveLength(3);
  });
});
