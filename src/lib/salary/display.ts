/** Compact only explicitly INR amounts. No FX conversion or changes to original foreign amounts. */
export function compactSalaryDisplay(value?: string | null): string {
  const text = value?.trim();
  if (!text) return "Not disclosed";
  if (!/\u20b9|\bINR\b/i.test(text)) return text;
  return text.replace(/\d[\d,]*(?:\.\d+)?/g, (raw, offset: number) => {
    // Keep already scaled units and unrelated period/experience numbers unchanged.
    if (/^\s*(?:cr|crore|lakh|lac|lpa|L\b|k\b|m\b)/i.test(text.slice(offset + raw.length))) return raw;
    const n = Number(raw.replace(/,/g, ""));
    if (n < 100000) return raw;
    const divisor = n >= 10000000 ? 10000000 : 100000;
    return `${Number((n / divisor).toFixed(1))} ${divisor === 10000000 ? "Cr" : "Lakh"}`;
  });
}
