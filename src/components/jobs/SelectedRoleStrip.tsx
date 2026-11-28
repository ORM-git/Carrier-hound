"use client";

import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { visibleChipCount } from "@/lib/jobs/chipRows";

// Selected job functions in the Preferences picker: compact chips, at most two rows when collapsed, a "+N" toggle that
// reserves its own width on the second row, "Show less" when expanded. The strip sits above the search box in normal
// flow, so it cannot overlap it. Chip colours and wording are the existing CM ones.

const GAP = 6; // px, equals gap-1.5
const MAX_ROWS = 2;
const CHIP = "inline-flex h-6 max-w-full items-center rounded-lg bg-[#DBEAFE] pl-2.5 text-[13px] font-medium leading-none text-[#0F172A]";
const TOGGLE = "inline-flex h-6 shrink-0 items-center justify-center rounded-lg bg-[#E2E8F0] px-2.5 text-[13px] font-semibold leading-none text-[#334155] hover:bg-[#CBD5E1] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#2563EB]";

function Chip({ role, onRemove }: { role: string; onRemove?: (r: string, e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <span className={CHIP} data-role-chip={role}>
      <span className="truncate" title={role}>{role}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={(e) => onRemove(role, e)}
          aria-label={`Remove ${role}`}
          data-remove
          className="ml-0 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-r-lg text-[#1E40AF] hover:text-rose-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#2563EB]"
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      ) : <span className="w-2.5" />}
    </span>
  );
}

export default function SelectedRoleStrip({ roles, onRemove }: { roles: string[]; onRemove: (role: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState<number>(roles.length);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [fontTick, setFontTick] = useState(0); // bumps when web fonts finish loading: chip widths change at a constant strip width
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocus = useRef<{ index: number } | null>(null);
  const regionId = useId();
  const key = useMemo(() => roles.join("\u0000"), [roles]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const read = () => setWidth(el.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The host element is always mounted (even with no roles), so this effect and its observer attach once and keep
  // working when roles go empty -> non-empty -> empty -> non-empty.
  useEffect(() => {
    const fonts = typeof document !== "undefined" ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
    if (!fonts) return;
    let alive = true;
    const bump = () => { if (alive) setFontTick((t) => t + 1); };
    fonts.ready?.then(bump).catch(() => {});
    fonts.addEventListener?.("loadingdone", bump);
    return () => { alive = false; fonts.removeEventListener?.("loadingdone", bump); };
  }, []);

  useEffect(() => { if (roles.length === 0) setExpanded(false); }, [roles.length]);

  // Apply a pending focus move after the DOM has the new chips/toggle.
  useEffect(() => {
    const want = pendingFocus.current;
    if (!want) return;
    pendingFocus.current = null;
    const host = hostRef.current;
    if (!host) return;
    const btns = Array.from(host.querySelectorAll<HTMLButtonElement>("[aria-label='Selected job functions'] button[data-remove]"));
    const target = btns[Math.min(want.index, btns.length - 1)] ?? toggleRef.current ?? host;
    target.focus();
  });

  useLayoutEffect(() => {
    const m = measureRef.current;
    if (!m) return;
    const chips = Array.from(m.querySelectorAll<HTMLElement>("[data-measure-chip]")).map((c) => c.offsetWidth);
    const digits = String(Math.max(roles.length, 1)).length;
    const sample = m.querySelector<HTMLElement>("[data-measure-toggle]");
    const base = sample ? sample.offsetWidth : 0;
    const perDigit = digits > 1 ? Math.ceil(base / 3) : 0; // "+N" is about 3 glyphs wide; add room for extra digits
    const k = visibleChipCount({ widths: chips, width, gap: GAP, maxRows: MAX_ROWS, toggleWidth: () => base + perDigit * (digits - 1) });
    // Same guard when the measured limit (not the roles) is what removes the toggle: it is still mounted here.
    if (k >= roles.length && toggleRef.current && document.activeElement === toggleRef.current) pendingFocus.current = { index: roles.length - 1 };
    setLimit(k);
  }, [key, width, roles.length, fontTick]);

  const handleRemove = (role: string, e: React.MouseEvent<HTMLButtonElement>) => {
    // Keep keyboard focus on something actionable: the chip that takes this one's place (or the previous one).
    if (document.activeElement === e.currentTarget) pendingFocus.current = { index: roles.indexOf(role) };
    onRemove(role);
  };
  const hidden = Math.max(roles.length - limit, 0);
  const collapsedView = !expanded && hidden > 0;
  const shown = collapsedView ? roles.slice(0, limit) : roles;
  const canCollapse = expanded && hidden > 0;
  // The toggle element is about to unmount while it has focus (the list shrank so everything fits): read the old DOM
  // now, during render, and hand focus to a chip control after commit. No-op on the server and on first render.
  if (typeof document !== "undefined" && !(collapsedView || canCollapse) && toggleRef.current && document.activeElement === toggleRef.current) {
    pendingFocus.current = { index: roles.length - 1 };
  }

  return (
    <div className={roles.length > 0 ? "relative mb-3" : "relative"} ref={hostRef} tabIndex={-1} style={{ outline: "none" }}>
      {roles.length > 0 && (
      <div
        id={regionId}
        aria-label="Selected job functions"
        data-expanded={expanded && hidden > 0 ? "true" : "false"}
        className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 ${expanded && hidden > 0 ? "max-h-[40dvh] overflow-y-auto overscroll-contain" : ""}`}
      >
        {shown.map((r) => <Chip key={r} role={r} onRemove={handleRemove} />)}
        {(collapsedView || canCollapse) && (
          // One button element for both states, so focus stays on it when it switches between "+N" and "Show less".
          <button
            ref={toggleRef}
            type="button"
            className={TOGGLE}
            aria-expanded={canCollapse}
            aria-controls={regionId}
            aria-label={canCollapse ? undefined : `Show ${hidden} more selected job functions`}
            onClick={() => setExpanded(!canCollapse)}
          >
            {canCollapse ? "Show less" : `+${hidden}`}
          </button>
        )}
      </div>
      )}
      {/* Off-screen measuring copy: same chip markup, never visible, never focusable, not read by assistive tech. */}
      {roles.length > 0 && (
      <div ref={measureRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 -z-10 flex h-0 w-full flex-wrap gap-x-1.5 gap-y-1 overflow-hidden">
        {roles.map((r) => (
          <span key={r} data-measure-chip className={CHIP}><span className="truncate">{r}</span><span className="ml-0.5 inline-block h-6 w-6 shrink-0" /></span>
        ))}
        <span data-measure-toggle className={TOGGLE}>+9</span>
      </div>
      )}
    </div>
  );
}
