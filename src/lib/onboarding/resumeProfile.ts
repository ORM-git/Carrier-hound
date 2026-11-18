/**
 * src/lib/onboarding/resumeProfile.ts
 *
 * Turns extracted resume text (a resume, or a LinkedIn "Save to PDF" export) into the
 * small structured profile stored in public.onboarding_resume_profiles and used by
 * /api/jobs/recommended for ranking.
 *
 * Two sources, same output shape:
 *  - rules: deterministic, no network (always available)
 *  - ai:    the existing resume_extraction operation (src/lib/ai), merged over the rules result
 *
 * Only ranking-relevant fields are kept. No name, email, phone, URLs or raw text.
 * Edge-safe, pure TypeScript.
 */

import type { CandidateProfile } from "@/lib/resume/types";
import { parseResumeText } from "@/lib/resume/parser";
import { stripControlChars, stripHtmlAndExecutableMarkup } from "@/lib/security/xss";

export interface OnboardingResumeEducation {
  degree: string;
  institution: string;
  year: string;
}

export interface OnboardingResumeProfile {
  jobTitles: string[];
  skills: string[];
  yearsOfExperience: number | null;
  education: OnboardingResumeEducation[];
  location: string | null;
  preferredRoles: string[];
}

export const PROFILE_LIMITS = {
  jobTitles: 10,
  skills: 40,
  education: 5,
  preferredRoles: 5,
  titleChars: 120,
  skillChars: 60,
  eduChars: 200,
  locationChars: 120,
  maxYears: 50,
  maxJsonBytes: 32768,
} as const;

export const EMPTY_RESUME_PROFILE: OnboardingResumeProfile = {
  jobTitles: [],
  skills: [],
  yearsOfExperience: null,
  education: [],
  location: null,
  preferredRoles: [],
};

const PLACEHOLDER = /needs confirmation|university \/ college|^candidate$/i;
const SECTION_HEADING =
  /^(contact|top skills|skills|languages|certifications|honors(?:-| & )awards|summary|experience|work experience|work history|professional experience|education|projects|publications|profile|about|objective|interests)\s*:?$/i;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};
const MONTH_RE = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE_TOKEN = `(?:${MONTH_RE}\\s+(?:19|20)\\d{2}|(?:0?[1-9]|1[0-2])[/.-](?:19|20)\\d{2}|(?:19|20)\\d{2})`;
const DATE_RANGE = new RegExp(
  `(${DATE_TOKEN})\\s*(?:-|–|—|to)\\s*(${DATE_TOKEN}|present|current|now|till date|today)`,
  "i"
);

/** Cleans one untrusted string: no markup, no control chars, single-spaced, capped. */
export function cleanField(input: unknown, max: number): string {
  if (input === null || input === undefined) return "";
  const s = stripControlChars(stripHtmlAndExecutableMarkup(String(input)))
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, max).trim();
}

function uniqueCaseless(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = it.toLowerCase();
    if (!it || seen.has(key) || PLACEHOLDER.test(it)) continue;
    seen.add(key);
    out.push(it);
    if (out.length >= max) break;
  }
  return out;
}

/** Month index (year * 12 + month) for a date token, or null. */
export function parseMonthIndex(token: string, now: Date = new Date()): number | null {
  const t = token.trim().toLowerCase();
  if (/^(present|current|now|till date|today)$/.test(t)) return now.getUTCFullYear() * 12 + now.getUTCMonth();
  let m = t.match(new RegExp(`^(${MONTH_RE})\\s+((?:19|20)\\d{2})$`));
  if (m) {
    const mon = MONTHS[m[1].replace(/\./g, "").slice(0, 4) === "sept" ? "sept" : m[1].slice(0, 3)];
    return mon === undefined ? null : Number(m[2]) * 12 + mon;
  }
  m = t.match(/^(\d{1,2})[/.-]((?:19|20)\d{2})$/);
  if (m) return Number(m[2]) * 12 + (Number(m[1]) - 1);
  m = t.match(/^((?:19|20)\d{2})$/);
  if (m) return Number(m[1]) * 12;
  return null;
}

/** Total years covered by the given month ranges, overlaps merged, 1 decimal. */
export function yearsFromRanges(ranges: Array<[number, number]>): number | null {
  const valid = ranges.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e >= s).sort((a, b) => a[0] - b[0]);
  if (valid.length === 0) return null;
  let total = 0;
  let [cs, ce] = valid[0];
  for (const [s, e] of valid.slice(1)) {
    if (s <= ce) ce = Math.max(ce, e);
    else {
      total += ce - cs;
      [cs, ce] = [s, e];
    }
  }
  total += ce - cs;
  const years = Math.round((total / 12) * 10) / 10;
  return Math.min(PROFILE_LIMITS.maxYears, Math.max(0, years));
}

function titleFromBeforeDate(before: string): string {
  const head = before.split(/\s+(?:-|–|—|\||@|at)\s+|,\s*|\s+\|\s*/i)[0] || "";
  return head.replace(/[\s,(|-]+$/, "").trim();
}

function looksLikeTitleLine(line: string): boolean {
  return (
    line.length >= 2 &&
    line.length <= 80 &&
    !DATE_RANGE.test(line) &&
    !SECTION_HEADING.test(line) &&
    !/@|https?:|www\./i.test(line) &&
    !/^[\d\s()+.-]+$/.test(line)
  );
}

/** Job titles and date ranges from lines like "Title - Company Jan 2020 - Present" or LinkedIn's
 *  "Company / Title / March 2021 - Present (3 years 9 months)". */
export function extractTimeline(lines: string[], now: Date = new Date()): { titles: string[]; ranges: Array<[number, number]> } {
  const titles: string[] = [];
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DATE_RANGE);
    if (!m) continue;
    const start = parseMonthIndex(m[1], now);
    const end = parseMonthIndex(m[2], now);
    // Education lines ("2014 - 2018") under an education heading are not jobs.
    let section = "";
    for (let j = i; j >= 0; j--) {
      if (SECTION_HEADING.test(lines[j])) {
        section = lines[j].toLowerCase();
        break;
      }
    }
    if (/education/.test(section)) continue;
    // End month is inclusive ("Jun 2018 - Dec 2019" is 19 months).
    if (start !== null && end !== null) ranges.push([start, end + 1]);
    const before = lines[i].slice(0, m.index).trim();
    let title = before.length > 2 ? titleFromBeforeDate(before) : "";
    if (!title && i > 0 && looksLikeTitleLine(lines[i - 1])) title = lines[i - 1];
    title = cleanField(title, PROFILE_LIMITS.titleChars);
    if (title && looksLikeTitleLine(title)) titles.push(title);
  }
  return { titles: uniqueCaseless(titles, PROFILE_LIMITS.jobTitles), ranges };
}

function sectionLines(lines: string[], heading: RegExp, maxLines = 30): string[] {
  const idx = lines.findIndex((l) => heading.test(l));
  if (idx < 0) return [];
  const out: string[] = [];
  for (let i = idx + 1; i < lines.length && out.length < maxLines; i++) {
    if (SECTION_HEADING.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

/** "Top Skills" (LinkedIn) and "Skills" sections: one per line or comma/pipe separated. */
export function extractSectionSkills(lines: string[]): string[] {
  const raw = [
    // LinkedIn exports list at most 3 top skills; its side column has no heading after
    // them, so reading further would pull in the name and headline of the main column.
    ...sectionLines(lines, /^top skills\s*:?$/i, 3),
    ...sectionLines(lines, /^(skills|technical skills|key skills|core skills)\s*:?$/i, 15),
  ];
  const items: string[] = [];
  for (const line of raw) {
    for (const part of line.split(/[,|•·;]/)) {
      const s = cleanField(part.replace(/^[-*]\s*/, ""), PROFILE_LIMITS.skillChars);
      if (s.length >= 1 && s.length <= 40 && s.split(" ").length <= 4 && !DATE_RANGE.test(s)) items.push(s);
    }
  }
  return items;
}

const LOCATION_LINE = /^[A-Z][A-Za-zÀ-ɏ .'-]{1,40}(?:,\s*[A-Z][A-Za-zÀ-ɏ .'-]{1,40}){1,2}$/;

/** Location ("City, Region[, Country]") near the top and the headline right above it. */
export function extractLocationAndHeadline(lines: string[]): { location: string | null; headline: string | null } {
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    const line = lines[i];
    if (!LOCATION_LINE.test(line) || /\d/.test(line)) continue;
    // Skip an institution line in an education section, e.g. "Indian Institute of Technology, Delhi".
    if (/\b(university|institute|college|school|academy)\b/i.test(line)) continue;
    const prev = i > 0 ? lines[i - 1] : "";
    const headline = prev && looksLikeTitleLine(prev) ? cleanField(prev, PROFILE_LIMITS.titleChars) : null;
    return { location: cleanField(line, PROFILE_LIMITS.locationChars), headline };
  }
  return { location: null, headline: null };
}

const DEGREE = /\b(bachelor|master|b\.?\s?tech|m\.?\s?tech|b\.?e\b|m\.?e\b|b\.?sc|m\.?sc|b\.?s\b|m\.?s\b|b\.?a\b|m\.?a\b|bca|mca|mba|bba|ph\.?d|doctorate|diploma|associate'?s? degree|high school|class xii|hsc|ssc)/i;
const INSTITUTION = /\b(university|institute|college|school|academy|iit|nit|iiit|iim)\b/i;

export function extractEducation(lines: string[]): OnboardingResumeEducation[] {
  const section = sectionLines(lines, /^education\s*:?$/i, 20);
  const out: OnboardingResumeEducation[] = [];
  for (let i = 0; i < section.length && out.length < PROFILE_LIMITS.education; i++) {
    const line = section[i];
    if (!DEGREE.test(line)) continue;
    const years = line.match(/\b(?:19|20)\d{2}\b/g) || [];
    const degree = cleanField(line.replace(/[·(]*\s*\(?\b(?:19|20)\d{2}\b.*$/, "").replace(/[·,\s-]+$/, ""), PROFILE_LIMITS.eduChars);
    const prev = i > 0 ? section[i - 1] : "";
    const next = i + 1 < section.length ? section[i + 1] : "";
    const institution = INSTITUTION.test(prev) && !DEGREE.test(prev) ? prev : INSTITUTION.test(next) && !DEGREE.test(next) ? next : "";
    if (degree) {
      out.push({
        degree,
        institution: cleanField(institution, PROFILE_LIMITS.eduChars),
        year: years.length > 0 ? years[years.length - 1] : "",
      });
    }
  }
  return out;
}

/** Splits a headline like "Senior Data Analyst at Acme | Ex-Beta" into role phrases. */
export function rolesFromHeadline(headline: string | null | undefined): string[] {
  if (!headline) return [];
  return headline
    .split(/\s*\|\s*|\s*·\s*|\s*•\s*/)
    .slice(0, 3)
    // "Senior Data Analyst at Acme" -> "Senior Data Analyst" (never keep the employer)
    .map((p) => p.split(/\s+(?:at|@)\s+|\s+-\s+|,/i)[0])
    .map((p) => cleanField(p, 80))
    .filter((p) => p.length >= 3 && p.length <= 60 && /[a-z]/i.test(p) && !/^(ex|former|open to)\b/i.test(p));
}

function finalize(p: OnboardingResumeProfile): OnboardingResumeProfile {
  const out: OnboardingResumeProfile = {
    jobTitles: uniqueCaseless(p.jobTitles.map((t) => cleanField(t, PROFILE_LIMITS.titleChars)), PROFILE_LIMITS.jobTitles),
    skills: uniqueCaseless(p.skills.map((s) => cleanField(s, PROFILE_LIMITS.skillChars)), PROFILE_LIMITS.skills),
    yearsOfExperience:
      typeof p.yearsOfExperience === "number" && Number.isFinite(p.yearsOfExperience)
        ? Math.min(PROFILE_LIMITS.maxYears, Math.max(0, Math.round(p.yearsOfExperience * 10) / 10))
        : null,
    education: p.education
      .map((e) => ({
        degree: cleanField(e.degree, PROFILE_LIMITS.eduChars),
        institution: PLACEHOLDER.test(e.institution || "") ? "" : cleanField(e.institution, PROFILE_LIMITS.eduChars),
        year: (String(e.year || "").match(/\b(?:19|20)\d{2}\b/) || [""])[0],
      }))
      .filter((e) => e.degree && !PLACEHOLDER.test(e.degree))
      .slice(0, PROFILE_LIMITS.education),
    location: p.location ? cleanField(p.location, PROFILE_LIMITS.locationChars) || null : null,
    preferredRoles: uniqueCaseless(p.preferredRoles.map((r) => cleanField(r, 80)), PROFILE_LIMITS.preferredRoles),
  };
  while (JSON.stringify(out).length > PROFILE_LIMITS.maxJsonBytes && out.skills.length > 0) out.skills.pop();
  return out;
}

/** True when the profile carries at least one signal ranking can use. */
export function hasProfileSignal(p: OnboardingResumeProfile | null | undefined): boolean {
  return Boolean(p && (p.jobTitles.length > 0 || p.skills.length > 0 || p.preferredRoles.length > 0 || p.yearsOfExperience !== null));
}

function toLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Deterministic parse. Never throws; returns an empty profile on unreadable input. */
export function parseResumeProfileRules(text: string, now: Date = new Date()): OnboardingResumeProfile {
  const lines = toLines(text || "");
  if (lines.length === 0) return { ...EMPTY_RESUME_PROFILE };

  let base: CandidateProfile | null = null;
  try {
    base = parseResumeText(text).profile;
  } catch {
    base = null;
  }

  const { titles, ranges } = extractTimeline(lines, now);
  const { location, headline } = extractLocationAndHeadline(lines);
  const education = extractEducation(lines);
  const skills = [...extractSectionSkills(lines), ...(base?.skills || [])];

  const preferredRoles = [...rolesFromHeadline(headline), ...titles.slice(0, 2)];

  return finalize({
    jobTitles: titles,
    skills,
    yearsOfExperience: yearsFromRanges(ranges),
    education:
      education.length > 0
        ? education
        : (base?.education || []).map((e) => ({ degree: e.degree, institution: e.institution, year: e.year })),
    location: location || base?.location || null,
    preferredRoles,
  });
}

/**
 * Merges the AI extraction (CandidateProfile shape from the resume_extraction operation)
 * over the rules result. AI wins where it has values; rules fill the gaps.
 */
export function mergeAiProfile(
  ai: Partial<CandidateProfile> | null | undefined,
  rules: OnboardingResumeProfile,
  now: Date = new Date()
): OnboardingResumeProfile {
  if (!ai || typeof ai !== "object") return rules;
  const exp = Array.isArray(ai.experience) ? ai.experience.filter((e) => e && typeof e === "object") : [];
  const aiTitles = exp.map((e) => String(e.role || "")).filter((t) => t && !PLACEHOLDER.test(t));
  const aiRanges: Array<[number, number]> = [];
  for (const e of exp) {
    const s = parseMonthIndex(String(e.startDate || ""), now);
    const en = parseMonthIndex(String(e.endDate || "") || "present", now);
    if (s !== null && en !== null) aiRanges.push([s, en + 1]);
  }
  const aiSkills = Array.isArray(ai.skills) ? ai.skills.map((s) => String(s || "")) : [];
  const aiEdu = Array.isArray(ai.education)
    ? ai.education
        .filter((e) => e && typeof e === "object")
        .map((e) => ({ degree: String(e.degree || ""), institution: String(e.institution || ""), year: String(e.year || "") }))
    : [];
  const aiYears = yearsFromRanges(aiRanges);

  return finalize({
    jobTitles: [...aiTitles, ...rules.jobTitles],
    skills: [...aiSkills, ...rules.skills],
    yearsOfExperience: aiYears ?? rules.yearsOfExperience,
    education: aiEdu.length > 0 ? aiEdu : rules.education,
    location: (ai.location && String(ai.location)) || rules.location,
    preferredRoles: [...rolesFromHeadline(ai.headline ? String(ai.headline) : null), ...rules.preferredRoles, ...aiTitles.slice(0, 2)],
  });
}

/** Validates and normalizes a stored profile read back from the database. */
export function normalizeStoredProfile(raw: unknown): OnboardingResumeProfile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const years = typeof r.yearsOfExperience === "number" ? r.yearsOfExperience : null;
  const edu = Array.isArray(r.education)
    ? (r.education as unknown[])
        .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
        .map((e) => ({ degree: String(e.degree || ""), institution: String(e.institution || ""), year: String(e.year || "") }))
    : [];
  return finalize({
    jobTitles: arr(r.jobTitles),
    skills: arr(r.skills),
    yearsOfExperience: years,
    education: edu,
    location: typeof r.location === "string" ? r.location : null,
    preferredRoles: arr(r.preferredRoles),
  });
}
