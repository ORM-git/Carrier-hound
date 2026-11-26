/**
 * Offline extraction of required vs preferred job skills (checklist #27, first slice). Pure and unwired:
 * nothing in scoring, ranking, ingestion, the API or the UI reads it yet.
 *
 * Supported:
 * - Required skills come only from explicit requirement / minimum-qualification bullet lists, and preferred skills
 *   only from preferred / nice-to-have lists, both as lifted by `descriptionSections` (headed bullets only).
 *   Inside a requirements list, a bullet that says "preferred", "nice to have", "a plus", "bonus", "ideally" etc.
 *   counts as preferred.
 * - A structured `skills` field is `unspecified`: it says nothing about must vs nice-to-have.
 * - Skills are recognised only through `GENUINE_SKILL_ALIASES` (the scorer's table, read-only). Nothing is inferred
 *   from related tools. Every entry keeps the matched raw text, the full source text and where it came from.
 *
 * Conservative limits:
 * - Prose, responsibilities, benefits, EEO and company text never add skills.
 * - A clause with a negation cue ("not required", "no ... needed", "without") adds none of its skills; they are
 *   listed under `negated` instead.
 * - "A or B" (or "A/B", "either", "one of") becomes one `alternatives` group, never two requirements. A clause that
 *   mixes "or" with "and", or offers one skill "or similar/equivalent", cannot be represented safely, so its skills
 *   go to `unspecified` and the clause is listed in `ambiguous`.
 * - A skill that is both required and preferred stays in both lists and is reported in `conflicts`, unresolved.
 * - Ambiguous short aliases (go, js, ts, py, pg, node, rest, gql) are not matched in free text, except "Go",
 *   "Node" and "REST" written exactly like that. They are matched in the structured field.
 *   shortcut: no sentence parsing; upgrade to a real clause parser if these rules miss real postings.
 */
import { descriptionSections } from "./descriptionSections";
import { GENUINE_SKILL_ALIASES, getCanonicalSkillId } from "../matcher/scoring";

export const extractorVersion = "skill-requirements-v1";

export type SkillProvenance = "requirements_section" | "preferred_section" | "structured_skills";

export interface SkillEvidence {
  /** The text that matched, exactly as written in the source. */
  raw: string;
  /** The whole bullet or structured value it came from. */
  sourceText: string;
  provenance: SkillProvenance;
}

export interface SkillEntry {
  /** Canonical id from GENUINE_SKILL_ALIASES. */
  skill: string;
  evidence: SkillEvidence[];
}

export interface AlternativeGroup {
  /** Which list the group would belong to; at least one option is meant, not all. */
  bucket: "required" | "preferred";
  options: string[];
  evidence: SkillEvidence[];
}

export interface SkillRequirements {
  extractorVersion: string;
  required: SkillEntry[];
  preferred: SkillEntry[];
  unspecified: SkillEntry[];
  alternatives: AlternativeGroup[];
  negated: SkillEntry[];
  conflicts: { skill: string; required: SkillEvidence[]; preferred: SkillEvidence[] }[];
  /** Clauses whose meaning could not be represented safely (their skills are in `unspecified`). */
  ambiguous: SkillEvidence[];
  /** Structured skill values with no supported alias. Kept as evidence, never normalised. */
  unrecognizedStructured: string[];
}

export interface SkillRequirementsInput {
  description?: string | null;
  /** The posting's structured skills field, if any. */
  skills?: unknown;
}

// Ambiguous in prose: only these exact spellings are matched in free text.
const CASE_SENSITIVE_IN_TEXT: Record<string, string> = { go: "Go", node: "Node", rest: "REST" };
const TEXT_EXCLUDED = new Set(["js", "ts", "py", "pg", "gql"]);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Longest alias first, so "react native" wins over "react" and "asp.net" over ".net".
const TEXT_ALIASES = Object.entries(GENUINE_SKILL_ALIASES)
  .flatMap(([skill, aliases]) => aliases.filter((a) => !TEXT_EXCLUDED.has(a)).map((alias) => ({ skill, alias })))
  .sort((a, b) => b.alias.length - a.alias.length)
  .map(({ skill, alias }) => {
    const exact = CASE_SENSITIVE_IN_TEXT[alias];
    const body = escape(exact ?? alias);
    // The negative lookahead stops "Go-getter"-style compounds and "JavaScript" matching "java".
    return { skill, re: new RegExp(`(?<![A-Za-z0-9+#.])${body}(?![A-Za-z0-9+#]|-[a-z])`, exact ? "g" : "gi") };
  });

const NEGATION = /\b(?:not (?:required|necessary|needed|a requirement|mandatory)|no (?:\w+ ){0,3}(?:required|needed|necessary)|(?:do|does|don't|doesn't) (?:not )?need|no need|without|isn't required|aren't required)\b/i;
const PREFERRED_CUE = /\b(?:preferred|nice[- ]to[- ]have|a plus|bonus|ideally|desirable|desired|is an advantage|advantageous)\b/i;
const OR_CUE = /\bor\b|\beither\b|\bone of\b|\bany of\b/i;
const AND_CUE = /\band\b|&|\bas well as\b/i;

function findSkills(text: string): { skill: string; raw: string }[] {
  const taken: [number, number][] = [];
  const found: { skill: string; raw: string; at: number }[] = [];
  for (const { skill, re } of TEXT_ALIASES) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const [start, end] = [m.index, m.index + m[0].length];
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      found.push({ skill, raw: m[0], at: start });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ skill, raw }) => ({ skill, raw }));
}

/** Clauses split on ";" and sentence breaks, so one negated sentence does not swallow the rest of a bullet. */
const clauses = (bullet: string) => bullet.split(/;|(?<=[A-Za-z0-9)+#])\.\s+(?=[A-Z])/).map((c) => c.trim()).filter(Boolean);

export function extractSkillRequirements(input: SkillRequirementsInput): SkillRequirements {
  const buckets = { required: new Map<string, SkillEvidence[]>(), preferred: new Map<string, SkillEvidence[]>(), unspecified: new Map<string, SkillEvidence[]>(), negated: new Map<string, SkillEvidence[]>() };
  const add = (b: keyof typeof buckets, skill: string, e: SkillEvidence) => buckets[b].set(skill, [...(buckets[b].get(skill) ?? []), e]);
  const alternatives: AlternativeGroup[] = [];
  const ambiguous: SkillEvidence[] = [];

  const sections = descriptionSections(input.description);
  const lists: [string[], SkillProvenance][] = [
    [sections.requirements, "requirements_section"],
    [sections.preferred, "preferred_section"],
  ];
  for (const [bullets, provenance] of lists) {
    for (const bullet of bullets) {
      for (const clause of clauses(bullet)) {
        const mentions = findSkills(clause);
        if (!mentions.length) continue;
        const ev = (raw: string): SkillEvidence => ({ raw, sourceText: bullet, provenance });
        if (NEGATION.test(clause)) {
          mentions.forEach((m) => add("negated", m.skill, ev(m.raw)));
          continue;
        }
        const bucket = provenance === "preferred_section" || PREFERRED_CUE.test(clause) ? "preferred" : "required";
        const distinct = Array.from(new Set(mentions.map((m) => m.skill)));
        const hasOr = OR_CUE.test(clause) || /\w\s*\/\s*\w/.test(clause.replace(/ci\/cd/gi, ""));
        if (hasOr) {
          // "Python or similar" names one option and an open-ended other one: not a safe requirement either way.
          if (distinct.length === 1 || AND_CUE.test(clause)) {
            ambiguous.push({ raw: clause, sourceText: bullet, provenance });
            mentions.forEach((m) => add("unspecified", m.skill, ev(m.raw)));
          } else {
            alternatives.push({ bucket, options: distinct, evidence: mentions.map((m) => ev(m.raw)) });
          }
          continue;
        }
        mentions.forEach((m) => add(bucket, m.skill, ev(m.raw)));
      }
    }
  }

  const structured = Array.isArray(input.skills) ? input.skills : typeof input.skills === "string" ? input.skills.split(/[,;\n]/) : [];
  const unrecognizedStructured: string[] = [];
  for (const value of structured) {
    if (typeof value !== "string" || !value.trim()) continue;
    const skill = getCanonicalSkillId(value);
    if (skill) add("unspecified", skill, { raw: value.trim(), sourceText: value, provenance: "structured_skills" });
    else if (!unrecognizedStructured.includes(value.trim())) unrecognizedStructured.push(value.trim());
  }

  const entries = (m: Map<string, SkillEvidence[]>): SkillEntry[] => Array.from(m, ([skill, evidence]) => ({ skill, evidence }));
  return {
    extractorVersion,
    required: entries(buckets.required),
    preferred: entries(buckets.preferred),
    unspecified: entries(buckets.unspecified),
    alternatives,
    negated: entries(buckets.negated),
    conflicts: Array.from(buckets.required.keys())
      .filter((s) => buckets.preferred.has(s))
      .map((skill) => ({ skill, required: buckets.required.get(skill)!, preferred: buckets.preferred.get(skill)! })),
    ambiguous,
    unrecognizedStructured,
  };
}
