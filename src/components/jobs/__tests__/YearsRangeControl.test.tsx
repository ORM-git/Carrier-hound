// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RequiredYearsRange } from "@/lib/jobs/requiredYears";
import YearsRangeControl, { describeRange, handlesFromRange, isCustomRange } from "../YearsRangeControl";

afterEach(cleanup);

function Harness({ initial, onChange }: { initial: RequiredYearsRange | null; onChange: (r: RequiredYearsRange | null) => void }) {
  const [v, setV] = React.useState<RequiredYearsRange | null>(initial);
  return <YearsRangeControl value={v} onChange={(r) => { setV(r); onChange(r); }} />;
}
const maxBox = () => screen.getByLabelText("Maximum years of experience");
const minBox = () => screen.getByLabelText("Minimum years of experience");

describe("YearsRangeControl", () => {
  it("labels the exact stored range, never a rounded one", () => {
    expect(describeRange(null)).toBe("Any");
    expect(describeRange({ min: 2.5, max: 6 })).toBe("2.5 to 6 years");
    expect(describeRange({ min: 15, max: null })).toBe("15+ years");
    expect(describeRange({ min: 0, max: 15 })).toBe("0 to 15 years");
    expect(describeRange({ min: null, max: 4 })).toBe("0 to 4 years");
    expect(describeRange({ min: 11, max: null })).toBe("11+ years");
    expect(handlesFromRange({ min: 2, max: null })).toEqual([2, 11]);
    expect(isCustomRange({ min: 2.5, max: 6 })).toBe(true);
    expect(isCustomRange({ min: 2, max: 6 })).toBe(false);
    expect(isCustomRange({ min: 15, max: null })).toBe(true);
  });
  it("shows exact decimal and out-of-slider values and says so", () => {
    render(<Harness initial={{ min: 2.5, max: 15 }} onChange={vi.fn()} />);
    expect(screen.getByTestId("years-summary").textContent).toBe("2.5 to 15 years");
    expect(screen.getByText(/Saved range is shown exactly/)).toBeTruthy();
  });
  it("editing the upper handle keeps the untouched decimal minimum exactly", () => {
    const onChange = vi.fn();
    render(<Harness initial={{ min: 2.5, max: 6 }} onChange={onChange} />);
    fireEvent.change(maxBox(), { target: { value: "8" } });
    expect(onChange).toHaveBeenLastCalledWith({ min: 2.5, max: 8 });
    fireEvent.change(maxBox(), { target: { value: "11" } });
    expect(onChange).toHaveBeenLastCalledWith({ min: 2.5, max: null });
  });
  it("editing the lower handle keeps an out-of-slider maximum exactly", () => {
    const onChange = vi.fn();
    render(<Harness initial={{ min: 1, max: 15 }} onChange={onChange} />);
    fireEvent.change(minBox(), { target: { value: "3" } });
    expect(onChange).toHaveBeenLastCalledWith({ min: 3, max: 15 });
  });
  it("a min of 15 stays when only the maximum is touched, and the lower handle cannot pass an untouched max", () => {
    const onChange = vi.fn();
    render(<Harness initial={{ min: 15, max: null }} onChange={onChange} />);
    expect(screen.getByTestId("years-summary").textContent).toBe("15+ years");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(maxBox(), { target: { value: "8" } });
    expect(onChange).toHaveBeenLastCalledWith({ min: 15, max: 15 }); // the dragged max cannot go below the untouched min
    cleanup();
    const o2 = vi.fn();
    render(<Harness initial={{ min: 1, max: 4 }} onChange={o2} />);
    fireEvent.change(minBox(), { target: { value: "9" } });
    expect(o2).toHaveBeenLastCalledWith({ min: 4, max: 4 });
  });
  it("upper handle at the top means no max without forcing min to 11; lower 11 sets min 11; 0..top is null", () => {
    const onChange = vi.fn();
    render(<Harness initial={{ min: 2, max: 4 }} onChange={onChange} />);
    fireEvent.change(maxBox(), { target: { value: "11" } });
    expect(onChange).toHaveBeenLastCalledWith({ min: 2, max: null });
    fireEvent.change(minBox(), { target: { value: "11" } });
    expect(onChange).toHaveBeenLastCalledWith({ min: 11, max: null });
    fireEvent.change(minBox(), { target: { value: "0" } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
  it("does not call onChange when nothing is touched", () => {
    const onChange = vi.fn();
    render(<Harness initial={{ min: 2.5, max: 6 }} onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });
});
