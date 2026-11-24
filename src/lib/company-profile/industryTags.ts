/** Honest provenance label for a stored profile value. */
export function companySourceLabel(sourceUrl: string | null | undefined, sourceKind?: string | null): string {
  if (sourceKind === "wikidata") return "Wikidata";
  try { if (sourceUrl && new URL(sourceUrl).hostname === "www.wikidata.org") return "Wikidata"; } catch { /* not a URL */ }
  return "Official source";
}
