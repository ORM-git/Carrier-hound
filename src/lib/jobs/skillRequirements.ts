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
 * - Cues are scoped to their own proposition: "Java is required, Python is preferred" and "Java not required, but
 *   Python is mandatory" split at the comma / "but" / "and" only because each side has its own cue. Plain lists and
 *   alternatives are never split. A prefix cue ("Required: A, B") reaches forward, a postfix cue ("A and B are a
 *   plus") reaches back; an item that no cue reaches safely, or a "required" cue inside a preferred list, goes to
 *   `unspecified` and `ambiguous`.
 * - A negated proposition ("not required", "do not / don't need", "no ... needed", "without") adds none of its
 *   skills; they are listed under `negated` instead. "do / does need" is affirmative.
 * - "optional" overrides the section default in either list: the skill goes to `unspecified`, never `required`
 *   or `preferred`, because optional says nothing about whether it is wanted.
 * - A bare qualifier after a skill ("but preferred", "but not required", "though nice to have") combines with that
 *   skill's cue: "not required but preferred" and "preferred but not required" are both `preferred`; a contradiction
 *   ("required but optional") goes to `unspecified` and `ambiguous`.
 * - "&" joins propositions like "and": it splits only between parts that each carry their own cue.
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

export const extractorVersion = "skill-requirements-v3";

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

// "do/does need" is affirmative; only an explicit "not"/"n't"/"no" negates.
const NEGATION = /\b(?:not (?:required|necessary|needed|a requirement|mandatory|essential)|no (?:\w+ ){0,3}(?:required|needed|necessary)|(?:do|does|did) not need|(?:don|doesn|didn)['’]t need|no need|(?:isn|aren)['’]t (?:required|needed|necessary))\b/i;
const PREFERRED_CUE = /\b(?:preferred|nice[- ]to[- ]have|a plus|bonus|ideally|desirable|desired|is an advantage|advantageous)\b/i;
const REQUIRED_CUE = /\b(?:required|requirement|mandatory|must|essential|need|needed)\b/i; // not "needs": usually a noun ("business needs")
// Where one proposition ends and the next may begin inside a clause. Segments are only split apart when each
// carries its own cue; otherwise they are joined back, so plain lists and alternatives stay whole.
const SEGMENT_BREAK = /\s*,\s*(?:but|while|whereas|and|&)?\s*|\s+(?:but|while|whereas|and|&)\s+/gi;
// "optional" says the skill is not required but not that it is wanted: it overrides the section default and lands
// in `unspecified`, never `required` or `preferred`.
const OPTIONAL_CUE = /\boptional\b/i;
// "no degree required" / "no visa sponsorship needed" negate a non-skill noun, never the skill before them.
const NO_NOUN_NEGATION = /^\s*(?:(?:but|and|though|although|while|whereas)\s+)?no\s+(?:\w+\s+){1,3}(?:required|needed|necessary)\b/i;

type Cue = "required" | "preferred" | "negated" | "optional";
const CUES = [["negated", NEGATION], ["optional", OPTIONAL_CUE], ["preferred", PREFERRED_CUE], ["required", REQUIRED_CUE]] as const;
const cueOf = (text: string): { cue: Cue; at: number } | null => {
  for (const [cue, re] of CUES) {
    const m = re.exec(text);
    if (m) return { cue, at: m.index };
  }
  return null;
};

// A segment that is only a qualifier ("but preferred", "not required", "though nice to have") with no skill and no
// other words describes the skills just before it, so its cue is combined with theirs instead of standing alone.
const QUALIFIER_FILLER = /^[\s()\-:,.]*(?:(?:but|and|though|although|still|is|are|it|it's|very|much|strongly|highly|definitely|would|be)[\s()\-:,.]*)*$/i;
const bareQualifier = (text: string) => {
  let rest = text;
  for (const [, re] of CUES) rest = rest.replace(new RegExp(re.source, "gi"), " ");
  return rest !== text && QUALIFIER_FILLER.test(rest);
};
/** Cue for "<a> but <b>" about the same skills; null when they contradict ("required but optional"). */
function combineCues(a: Cue | undefined, b: Cue): Cue | null {
  if (!a || a === b) return b;
  const pair = new Set([a, b]);
  if (pair.has("preferred") && (pair.has("negated") || pair.has("optional"))) return "preferred"; // "not required but preferred"
  if (pair.has("optional") && pair.has("negated")) return "optional";
  return null;
}

interface Proposition {
  text: string;
  /** null = the cue cannot be scoped to this text safely. */
  cue: Cue | null;
}

/**
 * Splits a clause into propositions and gives each one the cue that applies to it. A segment without its own cue
 * takes a prefix cue on its left ("Required: A, B") or a postfix cue on its right ("A and B are a plus"); a clause
 * with no cue at all takes the section default. A segment left after other cued propositions, or caught between
 * two different cues, gets null.
 */
function propositions(clause: string, sectionDefault: Cue): Proposition[] {
  type Seg = { start: number; end: number; own: { cue: Cue | null; prefix: boolean } | null; contrast?: boolean };
  const raw: Seg[] = [];
  let start = 0;
  let contrast = false; // the break before the next segment was "but" / "while" / "whereas"
  for (const m of Array.from(clause.matchAll(SEGMENT_BREAK))) {
    if (m.index! > start) raw.push({ start, end: m.index!, own: null, contrast });
    start = m.index! + m[0].length;
    contrast = /\b(?:but|while|whereas)\b/i.test(m[0]);
  }
  if (start < clause.length) raw.push({ start, end: clause.length, own: null, contrast });
  const segs: Seg[] = [];
  for (const s of raw) {
    const text = clause.slice(s.start, s.end);
    const c = cueOf(text);
    const firstSkill = findSkills(text)[0];
    const prev = segs[segs.length - 1];
    if (c && !firstSkill && NO_NOUN_NEGATION.test(text)) continue; // no skill in it, so it adds and cancels nothing
    if (c && !firstSkill && prev && bareQualifier(text) && findSkills(clause.slice(prev.start, prev.end)).length) {
      prev.end = s.end; // the qualifier joins the proposition it describes, so evidence covers both
      const contradicted = prev.own !== null && prev.own.cue === null;
      prev.own = { cue: contradicted ? null : combineCues(prev.own?.cue ?? undefined, c.cue), prefix: false };
      continue;
    }
    if (c) s.own = { cue: c.cue, prefix: !!firstSkill && c.at < text.indexOf(firstSkill.raw) };
    segs.push(s);
  }
  const cued = segs.filter((s) => s.own);
  if (!cued.length) return [{ text: clause, cue: sectionDefault }];
  const resolved = segs.map((s, i) => {
    if (s.own) return s.own.cue;
    const left = segs.slice(0, i).reverse().find((x) => x.own);
    const right = segs.slice(i + 1).find((x) => x.own);
    const from = new Set<Cue | null>();
    if (left?.own?.prefix) from.add(left.own.cue);
    if (right?.own && !right.own.prefix && !right.contrast) from.add(right.own.cue); // a postfix cue does not reach back across "but"
    if (from.size === 1) return Array.from(from)[0];
    if (from.size > 1 || left) return null; // two cues compete, or a trailing item after cued propositions
    return sectionDefault; // leading items before a prefix cue keep the section default
  });
  // Join neighbouring segments with the same cue, so "A, B, or C" stays one proposition.
  const out: Proposition[] = [];
  let groupStart = 0;
  for (let i = 0; i < segs.length; i++) {
    if (i === segs.length - 1 || resolved[i + 1] !== resolved[i] || resolved[i] === null) {
      out.push({ text: clause.slice(segs[groupStart].start, segs[i].end), cue: resolved[i] });
      groupStart = i + 1;
    }
  }
  return out;
}
const WITHOUT_BREAK = /\s*,\s*|\s+(?:but|while|whereas)\s+/i;
const OBJECT_FILLER = /\b(?:and|or|any|prior|previous|experience|knowledge|of|in|with|skills?|expertise|background|familiarity|the|needed|required|necessary)\b|[&\/,.()-]/gi;
/**
 * "without X" is handled apart from the cue words, because it negates only the skills in its own object phrase.
 * - A non-skill object ("without supervision") negates nothing and the text after it is processed as usual.
 * - A skill object made only of skills, "and" / "or" lists and filler words ("without prior Go experience",
 *   "without Java and Python experience") negates every skill in it.
 * - Anything else ("without supervision using Go", skills after a comma that follows a skill object) cannot be
 *   scoped safely: those skills go to `unspecified` and the text to `ambiguous`; none becomes negated or required.
 * Skills before "without" are never touched. Returns the clause without the handled text.
 */
function splitWithout(clause: string): {
  rest: string;
  negated: { skill: string; raw: string }[];
  uncertain: { skill: string; raw: string; text: string }[];
} {
  const parts = clause.split(/\bwithout\b/i);
  const negated: { skill: string; raw: string }[] = [];
  const uncertain: { skill: string; raw: string; text: string }[] = [];
  let rest = parts[0];
  for (const tail of parts.slice(1)) {
    const brk = WITHOUT_BREAK.exec(tail);
    const object = brk ? tail.slice(0, brk.index) : tail;
    const after = brk ? tail.slice(brk.index + brk[0].length) : "";
    const mentions = findSkills(object);
    if (!mentions.length) {
      rest += brk ? ", " + after : ""; // a non-skill object: carry on with what follows
      continue;
    }
    const leftover = mentions.reduce((t, m) => t.replace(m.raw, " "), object).replace(OBJECT_FILLER, " ").trim();
    const afterMentions = findSkills(after);
    if (!leftover && !afterMentions.length) negated.push(...mentions);
    else if (!leftover) {
      negated.push(...mentions); // the object itself is clean; what follows the comma cannot be scoped
      afterMentions.forEach((m) => uncertain.push({ ...m, text: after.trim() }));
    } else {
      [...mentions, ...afterMentions].forEach((m) => uncertain.push({ ...m, text: tail.trim() }));
    }
  }
  return { rest, negated, uncertain };
}
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
      const sectionDefault: Cue = provenance === "preferred_section" ? "preferred" : "required";
      for (const rawClause of clauses(bullet)) {
        const { rest: clause, negated: withoutSkills, uncertain } = splitWithout(rawClause);
        withoutSkills.forEach((m) => add("negated", m.skill, { raw: m.raw, sourceText: bullet, provenance }));
        uncertain.forEach((m) => {
          add("unspecified", m.skill, { raw: m.raw, sourceText: bullet, provenance });
          if (!ambiguous.some((a) => a.raw === m.text && a.sourceText === bullet)) ambiguous.push({ raw: m.text, sourceText: bullet, provenance });
        });
        for (const { text: prop, cue } of propositions(clause, sectionDefault)) {
          const mentions = findSkills(prop);
          if (!mentions.length) continue;
          const ev = (raw: string): SkillEvidence => ({ raw, sourceText: bullet, provenance });
          const unsafe = () => {
            ambiguous.push({ raw: prop, sourceText: bullet, provenance });
            mentions.forEach((m) => add("unspecified", m.skill, ev(m.raw)));
          };
          if (cue === "negated") {
            mentions.forEach((m) => add("negated", m.skill, ev(m.raw)));
            continue;
          }
          if (cue === "optional") {
            mentions.forEach((m) => add("unspecified", m.skill, ev(m.raw)));
            continue;
          }
          // No scopable cue, or "required" inside a preferred list: the source contradicts itself, so do not pick.
          if (cue === null || (cue === "required" && provenance === "preferred_section")) {
            unsafe();
            continue;
          }
          const distinct = Array.from(new Set(mentions.map((m) => m.skill)));
          const hasOr = OR_CUE.test(prop) || /\w\s*\/\s*\w/.test(prop.replace(/ci\/cd/gi, ""));
          if (hasOr) {
            // "Python or similar" names one option and an open-ended other one: not a safe requirement either way.
            if (distinct.length === 1 || AND_CUE.test(prop)) unsafe();
            else alternatives.push({ bucket: cue, options: distinct, evidence: mentions.map((m) => ev(m.raw)) });
            continue;
          }
          mentions.forEach((m) => add(cue, m.skill, ev(m.raw)));
        }
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

