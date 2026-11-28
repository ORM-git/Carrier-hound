import { describe, it, expect } from "vitest";
import { visibleChipCount } from "../chipRows";

const tw = (h: number) => 40 + (h > 9 ? 8 : 0);
const base = { gap: 6, maxRows: 2, toggleWidth: tw };

describe("visibleChipCount", () => {
  it("shows everything when it fits in two rows (no toggle)", () => {
    expect(visibleChipCount({ ...base, widths: [100, 100, 100, 100], width: 330 })).toBe(4);
    expect(visibleChipCount({ ...base, widths: [], width: 330 })).toBe(0);
  });
  it("reserves the +N toggle on row 2: the last visible chip leaves room for it", () => {
    // row1: 150+6+150=306 of 330. row2: 150 chip, then toggle 40 needs 150+6+40=196 <= 330, so 3 shown + toggle
    expect(visibleChipCount({ ...base, widths: [150, 150, 150, 150, 150, 150], width: 330 })).toBe(3);
    // row2 chip 280 wide: 280+6+40=326 <= 330 fits
    expect(visibleChipCount({ ...base, widths: [150, 150, 280, 90, 90], width: 330 })).toBe(3);
    // row2 chip 300 wide: 300+6+40=346 > 330, so the chip is dropped and the toggle takes its place
    expect(visibleChipCount({ ...base, widths: [150, 150, 300, 90], width: 330 })).toBe(2);
  });
  it("matches the screenshot case: 7 chips in a 330 px strip, 4 shown, +3", () => {
    const widths = [160, 150, 90, 120, 90, 160, 180];
    const k = visibleChipCount({ ...base, widths, width: 330 });
    expect(widths.length - k).toBeGreaterThan(0);
    expect(k).toBeGreaterThanOrEqual(2);
  });
  it("never needs a third row: toggle width grows with digits", () => {
    const widths = Array.from({ length: 40 }, () => 100);
    const k = visibleChipCount({ ...base, widths, width: 330 });
    expect(k).toBe(5); // 3 per row; row 2 holds 2 chips plus the +35 toggle (100+6+100+6+48=260)
  });
  it("a chip wider than the strip is treated as one full row", () => {
    expect(visibleChipCount({ ...base, widths: [900, 100, 300, 300], width: 330 })).toBe(2);
  });
  it("width unknown (0) shows everything", () => {
    expect(visibleChipCount({ ...base, widths: [100, 100, 100, 100, 100], width: 0 })).toBe(5);
  });
});
