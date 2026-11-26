"use client";
import React from "react";
import { REQUIRED_YEARS_SLIDER_TOP, normalizeRequiredYearsRange, type RequiredYearsRange } from "@/lib/jobs/requiredYears";

const TOP = REQUIRED_YEARS_SLIDER_TOP;
const fmt = (n: number) => String(Math.round(n * 10) / 10);

/** Stored range to slider positions (0..TOP). Display only: stored values are never rewritten from these. */
export function handlesFromRange(range: RequiredYearsRange | null | undefined): [number, number] {
  const r = normalizeRequiredYearsRange(range);
  const lo = r.min === null ? 0 : Math.min(TOP, Math.round(r.min));
  const hi = r.max === null ? TOP : Math.min(TOP, Math.max(0, Math.round(r.max)));
  return [lo, Math.max(lo, hi)];
}

/** True when a saved bound cannot sit on an integer slider position (decimals or values above the slider top). */
export function isCustomRange(range: RequiredYearsRange | null | undefined): boolean {
  const r = normalizeRequiredYearsRange(range);
  const off = (v: number | null) => v !== null && (!Number.isInteger(v) || v > TOP);
  return off(r.min) || off(r.max);
}

/** Label for the EXACT stored range. */
export function describeRange(range: RequiredYearsRange | null | undefined): string {
  const r = normalizeRequiredYearsRange(range);
  const lo = r.min ?? 0;
  if (lo <= 0 && r.max === null) return "Any";
  if (r.max === null) return `${fmt(lo)}+ years`;
  if (r.min === null || r.min === 0) return `0 to ${fmt(r.max)} years`;
  return r.min === r.max ? `${fmt(r.max)} years` : `${fmt(r.min)} to ${fmt(r.max)} years`;
}

/**
 * Two-handle years range, 0 to TOP+ (top = no upper bound). Presentational: the parent owns persistence
 * and must only render this once the saved fields exist.
 * Only the handle the user moves changes its bound. The other bound keeps its exact saved value, including
 * decimals and values beyond the slider. onChange gets the stored range, or null for 0..top.
 */
export default function YearsRangeControl({
  value,
  onChange,
  disabled = false,
  action,
}: {
  value: RequiredYearsRange | null | undefined;
  onChange: (next: RequiredYearsRange | null) => void;
  disabled?: boolean;
  action?: React.ReactNode;
}) {
  const r = normalizeRequiredYearsRange(value);
  const [lo, hi] = handlesFromRange(r);
  const custom = isCustomRange(r);
  const emit = (min: number | null, max: number | null) => onChange((min === null || min === 0) && max === null ? null : { min, max });
  const cls = "h-11 min-w-0 flex-1 accent-[#2563EB]";
  return (
    <fieldset disabled={disabled}>
      <div className="flex items-center justify-between">
        <legend className="text-[13px] font-bold text-[#0F172A]">Years of experience</legend>
        <span className="flex items-center">
          <span className="text-[12px] font-semibold text-[#334155]" data-testid="years-summary">{describeRange(r)}</span>
          {action}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <label className="w-[84px] shrink-0 text-[12px] text-[#475569]" htmlFor="pref-years-min">Minimum: <span className="font-semibold text-[#0F172A]">{r.min === null ? 0 : fmt(r.min)}</span></label>
        <input id="pref-years-min" aria-label="Minimum years of experience" type="range" min={0} max={TOP} step={1} value={lo} className={cls}
          onChange={(e) => {
            // The dragged minimum cannot pass the untouched maximum.
            const cap = r.max === null ? TOP : Math.floor(r.max);
            emit(Math.min(Number(e.target.value), cap), r.max);
          }} />
      </div>
      <div className="flex items-center gap-3">
        <label className="w-[84px] shrink-0 text-[12px] text-[#475569]" htmlFor="pref-years-max">Maximum: <span className="font-semibold text-[#0F172A]">{r.max === null ? `${TOP}+` : fmt(r.max)}</span></label>
        <input id="pref-years-max" aria-label="Maximum years of experience" type="range" min={0} max={TOP} step={1} value={hi} className={cls}
          aria-valuetext={r.max === null ? `${TOP}+ years, no upper limit` : undefined}
          onChange={(e) => {
            const v = Number(e.target.value);
            const floor = r.min === null ? 0 : Math.ceil(r.min);
            emit(r.min, v >= TOP ? null : Math.max(v, floor));
          }} />
      </div>
      <div className="ml-[96px] flex justify-between text-[11px] text-[#64748B]" aria-hidden="true"><span>0</span><span>{TOP}+</span></div>
      {custom && (
        <p className="mt-1 text-[12px] text-[#64748B]">Saved range is shown exactly. Moving a slider changes only that bound; use Clear to start over.</p>
      )}
    </fieldset>
  );
}
