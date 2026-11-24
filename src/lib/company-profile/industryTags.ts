/**
 * Deterministic industry tags: a fixed keyword table, no AI. A tag needs the company description to name it,
 * or at least 3 of the company's job titles to; job titles alone are noisy (every company hires "security").
 */
const RULES: Array<[tag: string, words: RegExp]> = [
  ["AI & machine learning", /\b(artificial intelligence|machine learning|deep learning|large language models?|generative ai|\bai\b)/i],
  ["Fintech & payments", /\b(payments?|fintech|financial (services|technology)|banking|neobank|lending|credit card)\b/i],
  ["Cybersecurity", /\b(cyber ?security|information security|zero trust|threat (detection|intelligence))\b/i],
  ["Cloud & infrastructure", /\b(cloud (computing|platform|infrastructure|services)|content delivery|cdn|edge network|data cent(er|re)s?)\b/i],
  ["Developer tools", /\b(developer (tools|platform)|devops|observability|database|open[- ]source software)\b/i],
  ["Software (SaaS)", /\b(saas|software as a service|enterprise software)\b/i],
  ["E-commerce & retail", /\b(e-?commerce|online retail|marketplace|retailer)\b/i],
  ["Healthcare & life sciences", /\b(healthcare|health care|medical|pharmaceutical|biotech(nology)?|life sciences)\b/i],
  ["Food & delivery", /\b(meal[- ]kit|food delivery|grocery|food company)\b/i],
  ["Semiconductors & hardware", /\b(semiconductors?|chipmaker|microprocessors?|gpus?)\b/i],
];

export function deriveIndustryTags(description: string | null | undefined, jobTitles: string[] = []): string[] {
  const text = (description || "").slice(0, 2000);
  const tags: string[] = [];
  for (const [tag, words] of RULES) {
    const inDescription = text ? words.test(text) : false;
    const inJobs = jobTitles.filter((title) => words.test(title)).length >= 3;
    if (inDescription || inJobs) tags.push(tag);
    if (tags.length === 3) break;
  }
  return tags;
}

/** Honest provenance label for a stored profile value. */
export function companySourceLabel(sourceUrl: string | null | undefined, sourceKind?: string | null): string {
  if (sourceKind === "wikidata") return "Wikidata";
  try { if (sourceUrl && new URL(sourceUrl).hostname === "www.wikidata.org") return "Wikidata"; } catch { /* not a URL */ }
  return "Official source";
}
