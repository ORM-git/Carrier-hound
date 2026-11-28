// Pure layout helper for the "selected chips, N rows, then +N" strip. No DOM access: callers pass measured widths.
// A chip is placed on the current row if it fits; otherwise a new row starts. The "+N" toggle is reserved on the
// last allowed row whenever some chips are hidden, so it can never be pushed onto a third row.

export interface ChipRowsInput {
  /** Measured outer width of each chip, in px (already capped to the container width by the caller or here). */
  widths: ReadonlyArray<number>;
  /** Container inner width in px. */
  width: number;
  /** Horizontal and vertical gap in px. */
  gap: number;
  /** Maximum rows in the collapsed state. */
  maxRows: number;
  /** Width of the "+N" toggle when N chips are hidden. */
  toggleWidth: (hidden: number) => number;
}

function rowsNeeded(items: ReadonlyArray<number>, width: number, gap: number): number {
  if (items.length === 0) return 0;
  let rows = 1;
  let x = 0;
  for (const raw of items) {
    const w = Math.min(Math.max(raw, 0), width);
    if (x === 0) { x = w; continue; }
    if (x + gap + w <= width) x += gap + w;
    else { rows += 1; x = w; }
  }
  return rows;
}

/** How many chips to show when collapsed. Returns widths.length when everything fits in maxRows (no toggle needed). */
export function visibleChipCount({ widths, width, gap, maxRows, toggleWidth }: ChipRowsInput): number {
  const n = widths.length;
  if (n === 0 || !(width > 0) || maxRows < 1) return n;
  if (rowsNeeded(widths, width, gap) <= maxRows) return n;
  for (let k = n - 1; k >= 1; k--) {
    const items = [...widths.slice(0, k), toggleWidth(n - k)];
    if (rowsNeeded(items, width, gap) <= maxRows) return k;
  }
  return 1;
}
