import { jobDescriptionText } from "./descriptionText";

export type DescriptionSections = {
  responsibilities: string[];
  requirements: string[];
  preferred: string[];
  benefits: string[];
};
/** Opt-in superset; descriptionSections() keeps its original four-key shape for existing consumers. */
export type ExtendedDescriptionSections = DescriptionSections & {
  education: string[];
  languages: string[];
};
type Section = keyof ExtendedDescriptionSections;
const headings: Record<Section, RegExp> = {
  responsibilities: /^(?:(?:(?:key|your|main) )?(?:responsibilities|duties)|what you(?:'|’)ll do)$/i,
  requirements: /^(?:(?:required|minimum|basic|essential) )?(?:qualifications|requirements)$/i,
  preferred: /^(?:preferred|desired|nice.to.have) (?:qualifications|requirements|skills)$/i,
  benefits: /^(?:(?:(?:employee|our) )?(?:benefits|perks)|what we offer)$/i,
  education: /^(?:education(?: requirements)?|educational qualifications)$/i,
  languages: /^(?:languages|language requirements)$/i,
};
const bullet = /^\s*(?:[-*•●▪◦]|\d+[.)])\s+(.+)$/;

/** Only lift explicit headed bullet lists. All original description text remains available. */
export function descriptionSections(description?: string | null): DescriptionSections {
  const { responsibilities, requirements, preferred, benefits } = extendedDescriptionSections(description);
  return { responsibilities, requirements, preferred, benefits };
}

/** Same headed-bullet-only discipline, plus explicit Education and Languages lists. */
export function extendedDescriptionSections(description?: string | null): ExtendedDescriptionSections {
  const result: ExtendedDescriptionSections = { responsibilities: [], requirements: [], preferred: [], benefits: [], education: [], languages: [] };
  const lines = jobDescriptionText(description, true).split(/\r?\n/);
  let section: Section | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.replace(/^#{1,6}\s*/, "").replace(/^\*\*|\*\*$/g, "").replace(/:$/, "").trim();
    const found = (Object.keys(headings) as Section[]).find(key => headings[key].test(heading));
    if (found) { section = found; continue; }
    const item = line.match(bullet)?.[1]?.trim();
    if (section && item) {
      if (!result[section].includes(item)) result[section].push(item);
    } else {
      // A paragraph or unrecognised heading ends a list, so EEO/company text cannot bleed in.
      section = null;
    }
  }
  return result;
}

/** Preserve explicit source lists; never stringify arbitrary objects into job content. */
export function structuredDescriptionList(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : typeof raw === "string" ? raw.split(/\r?\n/) : [];
  return Array.from(new Set(values.map(value => jobDescriptionText(value).replace(/^[-*•]\s*/, "").trim()).filter(Boolean)));
}
