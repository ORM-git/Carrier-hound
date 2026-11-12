import { CandidateProfile } from "../resume/types";
import { SKILLS_TAXONOMY } from "../resume/parser";
import {
  GENUINE_SKILL_ALIASES,
  getCanonicalSkillId,
  areSkillsGenuineMatch,
} from "../matcher/scoring";

export type FaithfulnessOperation =
  | "resume_extraction"
  | "cover_letter"
  | "job_fit";

export type FaithfulnessSeverity = "error" | "warning";

export type FaithfulnessVerdict = "faithful" | "unfaithful" | "inconclusive";

export type RelationVerificationStatus =
  | "verified_segmented"
  | "unverified_unsegmented"
  | "not_applicable";

export type FaithfulnessClaimKind =
  | "numeric_metric"
  | "skill_or_tool"
  | "employer_or_organization"
  | "role_or_title"
  | "education_or_degree"
  | "certification"
  | "date_or_year"
  | "contact_or_link"
  | "skill_contradiction"
  | "experience_claim"
  | "cross_employer_relation";

export interface UnverifiedClaim {
  kind: FaithfulnessClaimKind;
  claim: string;
  field: string;
  reason: string;
  severity: FaithfulnessSeverity;
}

export interface FaithfulnessReport {
  faithful: boolean;
  verdict: FaithfulnessVerdict;
  operation: FaithfulnessOperation;
  violations: UnverifiedClaim[];
  inconclusiveReasons: string[];
  relationsVerified: RelationVerificationStatus;
  limitations: string[];
  checkedCount: number;
  supportedCount: number;
}

export interface FaithfulnessJobContext {
  title?: string;
  company?: string;
  description?: string;
  location?: string;
}

export interface MatchExplanationOutput {
  score?: number;
  matchedSkills?: string[];
  missingSkills?: string[];
  summary?: string;
}

export interface FaithfulnessSourceInput {
  rawText?: string;
  candidate?: Partial<CandidateProfile>;
  job?: FaithfulnessJobContext;
}

export interface OrganizationMention {
  org: string;
  isApplicationTargetContext: boolean;
}

const DEFAULT_LIMITATIONS: string[] = [
  "Lexical/token containment is not semantic entailment; phrased responsibilities or causal claims are not logically proved.",
  "Subject-ownership and negation/aspiration rules rely on clause heuristics; ambiguous phrasing yields inconclusive rather than proof.",
  "Cross-employer relations in resume extraction use heuristic line/clause segmentation rather than full syntactic parsing.",
];

// Common English words that collide with lowercase taxonomy names in free prose.
const AMBIGUOUS_LOWERCASE_PROSE_SKILLS = new Set(["go", "rest", "shell"]);

// Common entity stopwords that follow prepositions ("at the", "at scale") without naming an org.
const ENTITY_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "this",
  "that",
  "scale",
  "present",
  "my",
  "our",
  "your",
  "all",
  "home",
  "work",
]);

const PHRASE_STOPWORDS = new Set([
  "of",
  "the",
  "and",
  "in",
  "at",
  "for",
  "to",
  "inc",
  "llc",
  "ltd",
  "corp",
  "co",
]);

const MONTH_ALIASES: Array<{ names: string[]; monthNum: string }> = [
  { names: ["january", "jan"], monthNum: "01" },
  { names: ["february", "feb"], monthNum: "02" },
  { names: ["march", "mar"], monthNum: "03" },
  { names: ["april", "apr"], monthNum: "04" },
  { names: ["may"], monthNum: "05" },
  { names: ["june", "jun"], monthNum: "06" },
  { names: ["july", "jul"], monthNum: "07" },
  { names: ["august", "aug"], monthNum: "08" },
  { names: ["september", "sept", "sep"], monthNum: "09" },
  { names: ["october", "oct"], monthNum: "10" },
  { names: ["november", "nov"], monthNum: "11" },
  { names: ["december", "dec"], monthNum: "12" },
];

const ONGOING_DATE_KEYWORD_REGEX =
  /\b(?:present|current|currently|ongoing|now|till\s+date|to\s+date)\b/i;

const RESUME_SECTION_HEADING_REGEX =
  /^(?:EDUCATION|ACADEMIC|SKILLS|TECHNICAL\s+SKILLS|CORE\s+SKILLS|CERTIFICATIONS?|LICENSES?|PROJECTS?|PUBLICATIONS?|AWARDS?|HONORS?|LANGUAGES?|INTERESTS?)\b[:\s]*$/i;

const CANONICAL_SKILL_LIST: string[] = Array.from(
  new Set([
    ...SKILLS_TAXONOMY.map((s) => s.toLowerCase().trim()),
    ...Object.keys(GENUINE_SKILL_ALIASES),
    ...Object.values(GENUINE_SKILL_ALIASES).flat(),
  ])
)
  .filter((s) => s.length > 1)
  .sort((a, b) => b.length - a.length);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalizes free text for deterministic boundary-safe containment checks.
 */
export function normalizeContainmentText(text: string | null | undefined): string {
  if (!text || typeof text !== "string") return "";
  return text
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^a-z0-9+#./@$-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts normalized numeric metrics, percentages, multipliers, currencies, and years.
 */
export function extractNumericFactsFromText(text: string | null | undefined): string[] {
  if (!text || typeof text !== "string") return [];
  const matches = text.match(
    /(?:[$€£])?\b\d+(?:[.,]\d+)*(?:%|[xXkKmMbB]|st|nd|rd|th|\+)?(?!\w)/g
  );
  if (!matches) return [];
  return Array.from(
    new Set(
      matches
        .map((m) => m.toLowerCase().replace(/,/g, "").trim())
        .filter(Boolean)
    )
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripDisambiguatedTechCompounds(skillLower: string, text: string): string {
  if (skillLower === "react") {
    return text.replace(/react[\s\-_]?native/gi, " ");
  }
  if (skillLower === "java") {
    return text.replace(/java[\s\-_]?script/gi, " ");
  }
  return text;
}

function isSkillTokenPresentWithBoundaries(skillLower: string, rawText: string): boolean {
  const cleaned = stripDisambiguatedTechCompounds(skillLower, rawText);
  const regex = new RegExp(`(^|[^a-z0-9+#])${escapeRegExp(skillLower)}([^a-z0-9+#]|$)`, "i");
  return regex.test(cleaned);
}

/**
 * Extracts canonical taxonomy skill mentions from prose while suppressing ambiguous English words
 * unless written in unambiguous casing (e.g. "Go", "REST", "Shell").
 */
export function extractTaxonomySkillsFromText(text: string | null | undefined): string[] {
  if (!text || typeof text !== "string") return [];
  const found: string[] = [];
  const seenCanonical = new Set<string>();

  for (const skillLower of CANONICAL_SKILL_LIST) {
    if (!isSkillTokenPresentWithBoundaries(skillLower, text)) {
      continue;
    }

    if (AMBIGUOUS_LOWERCASE_PROSE_SKILLS.has(skillLower)) {
      const strictCaseRegex =
        skillLower === "go"
          ? /(^|[^A-Za-z0-9+#])Go([^A-Za-z0-9+#]|$)/
          : skillLower === "rest"
          ? /(^|[^A-Za-z0-9+#])REST([^A-Za-z0-9+#]|$)/
          : /(^|[^A-Za-z0-9+#])Shell([^A-Za-z0-9+#]|$)/;
      if (!strictCaseRegex.test(text)) {
        continue;
      }
    }

    const canonical = getCanonicalSkillId(skillLower) || skillLower;
    if (!seenCanonical.has(canonical)) {
      seenCanonical.add(canonical);
      found.push(skillLower);
    }
  }

  return found;
}

/**
 * Returns true if a skill is evidenced in explicit skills or alias-aware source text.
 */
export function isCanonicalSkillSupported(
  skill: string,
  corpusText: string,
  explicitSkills: string[] = []
): boolean {
  const sLower = (skill || "").toLowerCase().trim();
  if (!sLower) return true;

  if (explicitSkills.some((cs) => cs && areSkillsGenuineMatch(cs, sLower))) {
    return true;
  }

  const canon = getCanonicalSkillId(sLower);
  const baseAliases = canon && GENUINE_SKILL_ALIASES[canon] ? GENUINE_SKILL_ALIASES[canon] : [sLower];
  const expandedAliases: string[] = [];
  for (const alias of baseAliases) {
    expandedAliases.push(alias);
    // Allow minor singular/plural inflection on multi-word domain phrases (e.g. "design systems" <-> "design system")
    if (alias.includes(" ")) {
      if (alias.endsWith("s") && alias.length > 5) {
        expandedAliases.push(alias.slice(0, -1));
      } else if (!alias.endsWith("s")) {
        expandedAliases.push(`${alias}s`);
      }
    }
  }
  return expandedAliases.some((alias) => isSkillTokenPresentWithBoundaries(alias, corpusText));
}

/**
 * Checks whether a structured entity phrase (company, role, degree, certification)
 * appears in normalized source text using exact boundary matching or significant-token containment.
 */
export function isPhraseContained(sourceRawOrNormalized: string, phrase: string): boolean {
  const normSource = normalizeContainmentText(sourceRawOrNormalized);
  const normPhrase = normalizeContainmentText(phrase);
  if (!normPhrase) return true;
  if (!normSource) return false;

  const boundaryRegex = new RegExp(`(^|\\s)${escapeRegExp(normPhrase)}(\\s|$)`, "i");
  if (boundaryRegex.test(normSource)) {
    return true;
  }

  const significantTokens = normPhrase
    .split(/\s+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t.length >= 2 && !PHRASE_STOPWORDS.has(t));

  if (significantTokens.length === 0) return false;

  const sourceTokenSet = new Set(
    normSource
      .split(/\s+/)
      .map((t) => t.replace(/^\.+|\.+$/g, ""))
      .filter(Boolean)
  );

  return significantTokens.every((tok) => {
    if (sourceTokenSet.has(tok)) return true;
    // Allow minor suffix stem equivalence on longer words (e.g. "engineering" <-> "engineer")
    if (tok.length >= 5) {
      return Array.from(sourceTokenSet).some(
        (st) => st.length >= 5 && (st.startsWith(tok) || tok.startsWith(st))
      );
    }
    return false;
  });
}

const STRICT_EMPLOYMENT_OR_STUDY_CUE_REGEX =
  /\b(?:worked\s+at|working\s+at|employed\s+(?:at|by)|tenure\s+at|experience\s+at|years?\s+at|yrs?\s+at|my\s+time\s+at|formerly\s+(?:at|with)|previously\s+(?:at|with)|prior\s+to\s+joining|graduated\s+from|studied\s+at)\s+([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,3})/g;

const ROLE_AT_ORG_CUE_REGEX =
  /\b(?:engineer|developer|manager|lead|director|analyst|architect|designer|intern|scientist|consultant)\s+at\s+([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,3})/g;

const APPLICATION_PREFIX_REGEX =
  /\b(?:apply(?:ing)?\s+(?:for|to)|application\s+for|interested\s+in|excited\s+(?:about|to\s+apply\s+for)|thrilled\s+to\s+apply\s+for|writing\s+(?:regarding|about|to\s+apply\s+for)|candidate\s+for|consideration\s+for|opportunity\s+(?:for|as)|opening\s+(?:for|as)|role\s+(?:of|as)|position\s+(?:of|as))\s+(?:the\s+|an?\s+)?(?:[A-Za-z0-9+.#/-]+\s+){0,5}$/i;

/**
 * Extracts organization mentions together with whether the grammatical cue is an application-target context
 * (e.g. "apply for Senior Engineer at <Company>") vs. claimed prior employment/study ("worked at <Company>").
 */
export function extractOrganizationMentionsWithContext(
  text: string | null | undefined
): OrganizationMention[] {
  if (!text || typeof text !== "string") return [];
  const results: OrganizationMention[] = [];
  const seenKey = new Set<string>();

  const pushMention = (rawOrg: string, isApplicationTargetContext: boolean) => {
    const candidateOrg = rawOrg.trim().replace(/[.,;:!?]+$/, "");
    if (!candidateOrg) return;
    const firstWord = candidateOrg.split(/\s+/)[0].toLowerCase();
    if (ENTITY_STOPWORDS.has(firstWord)) return;
    const key = `${candidateOrg.toLowerCase()}::${isApplicationTargetContext ? "app" : "emp"}`;
    if (!seenKey.has(key)) {
      seenKey.add(key);
      results.push({ org: candidateOrg, isApplicationTargetContext });
    }
  };

  let match: RegExpExecArray | null;
  STRICT_EMPLOYMENT_OR_STUDY_CUE_REGEX.lastIndex = 0;
  while ((match = STRICT_EMPLOYMENT_OR_STUDY_CUE_REGEX.exec(text)) !== null) {
    pushMention(match[1], false);
  }

  ROLE_AT_ORG_CUE_REGEX.lastIndex = 0;
  while ((match = ROLE_AT_ORG_CUE_REGEX.exec(text)) !== null) {
    const prefixStart = Math.max(0, match.index - 80);
    const preceding = text.slice(prefixStart, match.index);
    const isAppContext = APPLICATION_PREFIX_REGEX.test(preceding);
    pushMention(match[1], isAppContext);
  }

  return results;
}

/**
 * Extracts organization names mentioned after common employment or education cues.
 */
export function extractOrganizationMentions(text: string | null | undefined): string[] {
  return Array.from(new Set(extractOrganizationMentionsWithContext(text).map((m) => m.org)));
}

function collectCandidateEvidence(candidate: Partial<CandidateProfile> = {}): {
  text: string;
  explicitSkills: string[];
  numericSet: Set<string>;
  organizations: string[];
} {
  const parts: string[] = [
    candidate.name || "",
    candidate.email || "",
    candidate.phone || "",
    candidate.location || "",
    candidate.headline || "",
    candidate.summary || "",
    ...(candidate.skills || []),
    ...(candidate.certifications || []),
    ...(candidate.education || []).flatMap((ed) => [
      ed?.degree || "",
      ed?.institution || "",
      ed?.year || "",
      ed?.fieldOfStudy || "",
    ]),
    ...(candidate.experience || []).flatMap((e) => [
      e?.company || "",
      e?.role || "",
      e?.startDate || "",
      e?.endDate || "",
      e?.location || "",
      ...(e?.bullets || []),
    ]),
  ];

  const text = parts.filter(Boolean).join(" ");
  const numericSet = new Set(extractNumericFactsFromText(text));
  const explicitSkills = [
    ...(candidate.skills || []),
    ...(candidate.certifications || []),
  ].filter(Boolean);
  const organizations = [
    ...(candidate.experience || []).map((e) => e?.company || ""),
    ...(candidate.education || []).map((ed) => ed?.institution || ""),
  ]
    .map((s) => s.trim())
    .filter(Boolean);

  return { text, explicitSkills, numericSet, organizations };
}

function collectJobEvidence(job: FaithfulnessJobContext = {}): {
  text: string;
  numericSet: Set<string>;
  company: string;
  title: string;
  hasJobDetails: boolean;
} {
  const title = (job.title || "").trim();
  const company = (job.company || "").trim();
  const description = (job.description || "").trim();
  const location = (job.location || "").trim();
  const text = [title, company, location, description].filter(Boolean).join(" ");
  const numericSet = new Set(extractNumericFactsFromText(text));
  return {
    text,
    numericSet,
    company,
    title,
    hasJobDetails: Boolean(title || description),
  };
}

function isNumericSupported(num: string, allowedNumbers: Set<string>): boolean {
  const normalized = num.toLowerCase().replace(/,/g, "").trim();
  const withoutPlus = normalized.replace(/\+$/, "");
  return allowedNumbers.has(normalized) || allowedNumbers.has(withoutPlus);
}

function buildReport(
  operation: FaithfulnessOperation,
  violations: UnverifiedClaim[],
  checkedCount: number,
  options: {
    inconclusiveReasons?: string[];
    relationsVerified?: RelationVerificationStatus;
    limitations?: string[];
  } = {}
): FaithfulnessReport {
  const errorCount = violations.filter((v) => v.severity === "error").length;
  const failedFieldClaims = violations.filter((v) => v.severity === "error").length;
  const inconclusiveReasons = [...(options.inconclusiveReasons || [])];

  let verdict: FaithfulnessVerdict;
  if (errorCount > 0) {
    verdict = "unfaithful";
  } else if (inconclusiveReasons.length > 0 || checkedCount === 0) {
    verdict = "inconclusive";
    if (inconclusiveReasons.length === 0) {
      inconclusiveReasons.push("Zero verifiable claims were found to check against the source payload.");
    }
  } else {
    verdict = "faithful";
  }

  return {
    faithful: verdict === "faithful",
    verdict,
    operation,
    violations,
    inconclusiveReasons,
    relationsVerified: options.relationsVerified || "not_applicable",
    limitations: options.limitations || DEFAULT_LIMITATIONS,
    checkedCount,
    supportedCount: Math.max(0, checkedCount - failedFieldClaims),
  };
}

function isBulletLine(line: string): boolean {
  return /^\s*(?:[-*\u2022]|\d+[.)])\s+/.test(line);
}

function lineMatchesDistinctEmployer(
  line: string,
  targetCompany: string,
  allCompanies: string[]
): boolean {
  return allCompanies.some(
    (other) =>
      other &&
      !isPhraseContained(targetCompany, other) &&
      !isPhraseContained(other, targetCompany) &&
      isPhraseContained(line, other)
  );
}

function lineLooksLikeIndependentEntryHeader(line: string): boolean {
  if (!line || isBulletLine(line)) return false;
  const trimmed = line.trim();
  if (trimmed.length > 160) return false;
  const hasYearOrPresent =
    /\b(?:19|20)\d{2}\b/.test(trimmed) || ONGOING_DATE_KEYWORD_REGEX.test(trimmed);
  const hasSeparator = /[|\u2013\u2014]|\bat\b/i.test(trimmed);
  return hasYearOrPresent && (hasSeparator || /^[A-Z][A-Za-z0-9&.'-]*/.test(trimmed));
}

function isolateCommaClauseForCompany(line: string, company: string): string {
  const rawClauses = line.split(/\s*;\s*|\s*,\s+(?=[A-Z0-9])/);
  if (rawClauses.length <= 1) return line;

  const matchingIndices: number[] = [];
  for (let i = 0; i < rawClauses.length; i++) {
    if (isPhraseContained(rawClauses[i], company)) {
      matchingIndices.push(i);
    }
  }
  if (matchingIndices.length !== 1) return line;

  const anchorIdx = matchingIndices[0];
  let start = anchorIdx;
  let end = anchorIdx + 1;

  // Include an immediately preceding leading title/role clause without its own year or metric (e.g. "Senior Engineer, Acme Corp, 2021")
  while (start > 0) {
    const prev = rawClauses[start - 1].trim();
    const prevHasYear = /\b(?:19|20)\d{2}\b/.test(prev) || ONGOING_DATE_KEYWORD_REGEX.test(prev);
    const prevHasMetric = /[%$]|\b\d+[xXkKmMbB]\b/.test(prev);
    if (!prevHasYear && !prevHasMetric && prev.split(/\s+/).length <= 6) {
      start--;
    } else {
      break;
    }
  }

  let currentHasAnchorDateOrMetric =
    /\b(?:19|20)\d{2}\b/.test(rawClauses[anchorIdx]) ||
    ONGOING_DATE_KEYWORD_REGEX.test(rawClauses[anchorIdx]);

  while (end < rawClauses.length) {
    const next = rawClauses[end].trim();
    const nextStartsWithYear = /^(?:(?:19|20)\d{2}|present|current|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(
      next
    );
    const nextHasYearOrPresent =
      /\b(?:19|20)\d{2}\b/.test(next) || ONGOING_DATE_KEYWORD_REGEX.test(next);
    const nextStartsWithCapitalEntity = /^[A-Z][A-Za-z0-9&.'-]*/.test(next);

    // Stop if current segment already closed its date/fact and the next clause opens with a distinct capitalized entity + date/metric/title.
    if (
      !nextStartsWithYear &&
      currentHasAnchorDateOrMetric &&
      nextStartsWithCapitalEntity &&
      (nextHasYearOrPresent || /[%$]|director|engineer|manager|lead|analyst|developer/i.test(next))
    ) {
      break;
    }

    if (nextHasYearOrPresent) {
      currentHasAnchorDateOrMetric = true;
    }
    end++;
  }

  return rawClauses.slice(start, end).join(", ");
}

function resolveEmployerSegment(
  rawText: string,
  company: string,
  allCompanies: string[]
): { segmentText: string; segmented: boolean } {
  const trimmedCompany = company.trim();
  if (!trimmedCompany) return { segmentText: rawText, segmented: false };

  const lines = rawText.split(/\r?\n/);
  const matchingLineIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (RESUME_SECTION_HEADING_REGEX.test(line)) continue;
    if (isPhraseContained(line, trimmedCompany)) {
      matchingLineIndices.push(i);
    }
  }

  // Filter out bullet mentions when a clear header line also matches
  const nonBulletMatches = matchingLineIndices.filter((idx) => !isBulletLine(lines[idx]));
  const effectiveMatches = nonBulletMatches.length > 0 ? nonBulletMatches : matchingLineIndices;

  if (effectiveMatches.length !== 1) {
    return { segmentText: rawText, segmented: false };
  }

  const matchIdx = effectiveMatches[0];
  const matchedLine = lines[matchIdx];

  // If the single matched line itself holds multiple comma/semicolon employer entries, isolate the employer's clause.
  const clauseIsolated = isolateCommaClauseForCompany(matchedLine, trimmedCompany);
  const inlineSplitOccurred = clauseIsolated !== matchedLine;

  if (inlineSplitOccurred) {
    return { segmentText: clauseIsolated, segmented: true };
  }

  let startIdx = matchIdx;
  if (matchIdx > 0) {
    const prevLine = lines[matchIdx - 1].trim();
    const curHasDate =
      /\b(?:19|20)\d{2}\b/.test(matchedLine) || ONGOING_DATE_KEYWORD_REGEX.test(matchedLine);
    if (
      prevLine &&
      !isBulletLine(prevLine) &&
      !RESUME_SECTION_HEADING_REGEX.test(prevLine) &&
      !lineMatchesDistinctEmployer(prevLine, trimmedCompany, allCompanies) &&
      !/[%$]/.test(prevLine) &&
      !curHasDate
    ) {
      startIdx = matchIdx - 1;
    }
  }

  let endIdx = matchIdx + 1;
  let sawBullet = false;
  let sawDateOrRoleHeader =
    /\b(?:19|20)\d{2}\b/.test(matchedLine) ||
    ONGOING_DATE_KEYWORD_REGEX.test(matchedLine);

  while (endIdx < lines.length) {
    const line = lines[endIdx].trim();
    if (!line) {
      endIdx++;
      continue;
    }
    if (RESUME_SECTION_HEADING_REGEX.test(line)) {
      break;
    }
    if (lineMatchesDistinctEmployer(line, trimmedCompany, allCompanies)) {
      break;
    }
    if (isBulletLine(line)) {
      sawBullet = true;
      endIdx++;
      continue;
    }
    if (
      (sawBullet || sawDateOrRoleHeader) &&
      lineLooksLikeIndependentEntryHeader(line) &&
      !isPhraseContained(line, trimmedCompany)
    ) {
      break;
    }
    // Also break if we already finished bullets and hit a plain capitalized entity header line followed by a dated/bulleted line
    if (
      sawBullet &&
      /^[A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Za-z0-9&.'-]+){0,4}$/.test(line) &&
      endIdx + 1 < lines.length &&
      !isPhraseContained(line, trimmedCompany)
    ) {
      break;
    }
    if (/\b(?:19|20)\d{2}\b/.test(line) || ONGOING_DATE_KEYWORD_REGEX.test(line)) {
      sawDateOrRoleHeader = true;
    }
    endIdx++;
  }

  const segmentLines = lines.slice(startIdx, endIdx).join("\n").trim();
  if (!segmentLines) return { segmentText: rawText, segmented: false };
  return { segmentText: segmentLines, segmented: true };
}

function isMonthSupportedInText(monthNameLower: string, sourceText: string): boolean {
  const entry = MONTH_ALIASES.find((m) => m.names.includes(monthNameLower));
  if (!entry) return false;
  if (entry.names.some((n) => new RegExp(`\\b${escapeRegExp(n)}\\b`, "i").test(sourceText))) {
    return true;
  }
  const num = entry.monthNum;
  const numNoZero = String(Number(num));
  const numericMonthRegex = new RegExp(
    `(?:\\b(?:19|20)\\d{2}[-/]0?${numNoZero}\\b|\\b0?${numNoZero}[-/](?:19|20)\\d{2}\\b)`
  );
  return numericMonthRegex.test(sourceText);
}

function checkDateValueSupport(
  dateVal: string,
  segmentText: string,
  rawText: string,
  field: string,
  segmented: boolean,
  recordViolation: (
    kind: FaithfulnessClaimKind,
    claim: string,
    field: string,
    reason: string,
    severity?: FaithfulnessSeverity
  ) => void
): number {
  let checks = 0;
  const segmentNumbers = new Set(extractNumericFactsFromText(segmentText));
  const rawNumbers = new Set(extractNumericFactsFromText(rawText));
  const targetText = segmented ? segmentText : rawText;

  const years = dateVal.match(/\b(?:19|20)\d{2}\b/g) || [];
  for (const year of years) {
    checks++;
    if (!segmentNumbers.has(year)) {
      const existsElsewhere = segmented && rawNumbers.has(year);
      recordViolation(
        existsElsewhere ? "cross_employer_relation" : "date_or_year",
        year,
        field,
        existsElsewhere
          ? `Extracted year '${year}' appears outside this employer's source segment (cross-employer reassignment).`
          : `Extracted year '${year}' does not appear in source resume text.`
      );
    }
  }

  const ongoingMatches = dateVal.match(
    /\b(?:present|current|currently|ongoing|now|till\s+date|to\s+date)\b/gi
  );
  if (ongoingMatches) {
    for (const kw of ongoingMatches) {
      checks++;
      if (!ONGOING_DATE_KEYWORD_REGEX.test(targetText)) {
        const existsElsewhere = segmented && ONGOING_DATE_KEYWORD_REGEX.test(rawText);
        recordViolation(
          existsElsewhere ? "cross_employer_relation" : "date_or_year",
          kw,
          field,
          existsElsewhere
            ? `Extracted ongoing date keyword '${kw}' appears outside this employer's source segment.`
            : `Extracted date keyword '${kw}' is not supported by an ongoing/present marker in source resume text.`
        );
      }
    }
  }

  const allMonthWords = MONTH_ALIASES.flatMap((m) => m.names);
  const monthRegex = new RegExp(`\\b(${allMonthWords.join("|")})\\b`, "gi");
  let monthMatch: RegExpExecArray | null;
  while ((monthMatch = monthRegex.exec(dateVal)) !== null) {
    const monthToken = monthMatch[1];
    checks++;
    if (!isMonthSupportedInText(monthToken.toLowerCase(), targetText)) {
      recordViolation(
        "date_or_year",
        monthToken,
        field,
        `Extracted month '${monthToken}' does not appear in ${segmented ? "employer segment" : "source resume text"}.`
      );
    }
  }

  if (checks === 0 && dateVal.trim()) {
    checks++;
    if (!isPhraseContained(targetText, dateVal)) {
      recordViolation(
        "date_or_year",
        dateVal,
        field,
        `Extracted date value '${dateVal}' does not appear in source resume text.`
      );
    }
  }

  return checks;
}

/**
 * Verifies extracted resume JSON facts against the uploaded raw resume text (`rawText`).
 * Rejects fabricated skills, companies, roles, dates/date keywords, metrics, degrees, certifications,
 * contacts, and segment-mismatched cross-employer reassignments. Empty/invalid inputs return inconclusive.
 */
export function verifyResumeExtractionFaithfulness(
  extracted: Partial<CandidateProfile>,
  rawText: string
): FaithfulnessReport {
  if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
    return buildReport("resume_extraction", [], 0, {
      inconclusiveReasons: ["Source rawText is missing or empty; cannot verify extracted facts."],
    });
  }

  if (!isPlainRecord(extracted)) {
    return buildReport("resume_extraction", [], 0, {
      inconclusiveReasons: ["Extracted resume object is missing or invalid; cannot verify claims."],
    });
  }

  const violations: UnverifiedClaim[] = [];
  let checkedCount = 0;

  const rawLower = rawText.toLowerCase();
  const rawDigits = rawText.replace(/\D/g, "");
  const rawNumbers = new Set(extractNumericFactsFromText(rawText));

  const recordViolation = (
    kind: FaithfulnessClaimKind,
    claim: string,
    field: string,
    reason: string,
    severity: FaithfulnessSeverity = "error"
  ) => {
    violations.push({ kind, claim, field, reason, severity });
  };

  // Contact & identity checks
  if (typeof extracted.email === "string" && extracted.email.trim()) {
    checkedCount++;
    if (!rawLower.includes(extracted.email.trim().toLowerCase())) {
      recordViolation(
        "contact_or_link",
        extracted.email,
        "email",
        `Extracted email '${extracted.email}' does not appear in source resume text.`
      );
    }
  }

  if (typeof extracted.phone === "string" && extracted.phone.trim()) {
    const phoneDigits = extracted.phone.replace(/\D/g, "");
    if (phoneDigits.length >= 7) {
      checkedCount++;
      if (!rawDigits.includes(phoneDigits)) {
        recordViolation(
          "contact_or_link",
          extracted.phone,
          "phone",
          `Extracted phone '${extracted.phone}' does not match digits in source resume text.`
        );
      }
    }
  }

  if (typeof extracted.name === "string" && extracted.name.trim()) {
    checkedCount++;
    if (!isPhraseContained(rawText, extracted.name)) {
      recordViolation(
        "contact_or_link",
        extracted.name,
        "name",
        `Extracted name '${extracted.name}' is not contained in source resume text.`
      );
    }
  }

  // Extracted skills[] must be grounded in rawText
  if (Array.isArray(extracted.skills)) {
    for (let i = 0; i < extracted.skills.length; i++) {
      const skill = typeof extracted.skills[i] === "string" ? extracted.skills[i].trim() : "";
      if (!skill) continue;
      checkedCount++;
      const cleanedForSkill = stripDisambiguatedTechCompounds(skill.toLowerCase(), rawText);
      const grounded =
        isCanonicalSkillSupported(skill, rawText, []) ||
        (cleanedForSkill === rawText
          ? isPhraseContained(rawText, skill)
          : isPhraseContained(cleanedForSkill, skill));
      if (!grounded) {
        recordViolation(
          "skill_or_tool",
          skill,
          `skills[${i}]`,
          `Extracted skill '${skill}' is not evidenced in source resume text.`
        );
      }
    }
  }

  // Headline & summary numeric + canonical skill containment
  for (const textField of ["headline", "summary"] as const) {
    const rawFieldVal = extracted[textField];
    const val = typeof rawFieldVal === "string" ? rawFieldVal.trim() : "";
    if (!val) continue;
    for (const num of extractNumericFactsFromText(val)) {
      checkedCount++;
      if (!isNumericSupported(num, rawNumbers)) {
        recordViolation(
          "numeric_metric",
          num,
          textField,
          `Extracted ${textField} metric '${num}' does not appear in source resume text.`
        );
      }
    }
    for (const skill of extractTaxonomySkillsFromText(val)) {
      checkedCount++;
      if (!isCanonicalSkillSupported(skill, rawText, [])) {
        recordViolation(
          "skill_or_tool",
          skill,
          textField,
          `Extracted ${textField} mentions skill '${skill}' absent from source resume text.`
        );
      }
    }
  }

  // Experience entries with employer-segment isolation
  const expList = Array.isArray(extracted.experience) ? extracted.experience : [];
  const allExtractedCompanies = expList
    .map((e) => (e && typeof e.company === "string" ? e.company.trim() : ""))
    .filter(Boolean);

  let anySegmented = false;
  let anyUnsegmentedWithCompany = false;

  for (let i = 0; i < expList.length; i++) {
    const exp = expList[i];
    if (!exp || typeof exp !== "object") continue;

    const company = typeof exp.company === "string" ? exp.company.trim() : "";
    let companyPresentInSource = true;
    let segmentText = rawText;
    let segmented = false;

    if (company) {
      checkedCount++;
      companyPresentInSource = isPhraseContained(rawText, company);
      if (!companyPresentInSource) {
        recordViolation(
          "employer_or_organization",
          company,
          `experience[${i}].company`,
          `Extracted employer '${company}' does not appear in source resume text.`
        );
      } else {
        const resolved = resolveEmployerSegment(rawText, company, allExtractedCompanies);
        segmentText = resolved.segmentText;
        segmented = resolved.segmented;
        if (segmented) {
          anySegmented = true;
        } else {
          anyUnsegmentedWithCompany = true;
        }
      }
    }

    const segmentNumbers = new Set(extractNumericFactsFromText(segmentText));
    const checkScopeText = segmented ? segmentText : rawText;

    if (typeof exp.role === "string" && exp.role.trim()) {
      checkedCount++;
      if (!isPhraseContained(checkScopeText, exp.role)) {
        const elsewhere = segmented && companyPresentInSource && isPhraseContained(rawText, exp.role);
        recordViolation(
          elsewhere ? "cross_employer_relation" : "role_or_title",
          exp.role,
          `experience[${i}].role`,
          elsewhere
            ? `Extracted role '${exp.role}' exists in source text outside '${company}' segment (possible cross-employer reassignment).`
            : `Extracted role '${exp.role}' is not evidenced in source resume text.`
        );
      }
    }

    for (const dateField of ["startDate", "endDate"] as const) {
      const dateVal = typeof exp[dateField] === "string" ? exp[dateField].trim() : "";
      if (!dateVal) continue;
      checkedCount += checkDateValueSupport(
        dateVal,
        segmentText,
        rawText,
        `experience[${i}].${dateField}`,
        segmented && companyPresentInSource,
        recordViolation
      );
    }

    const bullets = Array.isArray(exp.bullets) ? exp.bullets : [];
    for (let b = 0; b < bullets.length; b++) {
      const bullet = typeof bullets[b] === "string" ? bullets[b].trim() : "";
      if (!bullet) continue;
      for (const num of extractNumericFactsFromText(bullet)) {
        checkedCount++;
        const allowedNums = segmented && companyPresentInSource ? segmentNumbers : rawNumbers;
        if (!isNumericSupported(num, allowedNums)) {
          const elsewhere = segmented && companyPresentInSource && isNumericSupported(num, rawNumbers);
          recordViolation(
            elsewhere ? "cross_employer_relation" : "numeric_metric",
            num,
            `experience[${i}].bullets[${b}]`,
            elsewhere
              ? `Extracted bullet metric '${num}' belongs to a different segment than employer '${company}' (possible cross-employer reassignment).`
              : `Extracted bullet metric '${num}' does not appear in source resume text.`
          );
        }
      }
      for (const skill of extractTaxonomySkillsFromText(bullet)) {
        checkedCount++;
        if (!isCanonicalSkillSupported(skill, checkScopeText, [])) {
          const elsewhere =
            segmented && companyPresentInSource && isCanonicalSkillSupported(skill, rawText, []);
          recordViolation(
            elsewhere ? "cross_employer_relation" : "skill_or_tool",
            skill,
            `experience[${i}].bullets[${b}]`,
            elsewhere
              ? `Extracted bullet skill '${skill}' appears outside '${company}' segment in source text.`
              : `Extracted bullet claims tool/skill '${skill}' absent from source resume text.`
          );
        }
      }
    }
  }

  // Education entries
  if (Array.isArray(extracted.education)) {
    for (let i = 0; i < extracted.education.length; i++) {
      const edu = extracted.education[i];
      if (!edu || typeof edu !== "object") continue;
      if (typeof edu.institution === "string" && edu.institution.trim()) {
        checkedCount++;
        if (!isPhraseContained(rawText, edu.institution)) {
          recordViolation(
            "education_or_degree",
            edu.institution,
            `education[${i}].institution`,
            `Extracted institution '${edu.institution}' does not appear in source resume text.`
          );
        }
      }
      if (typeof edu.degree === "string" && edu.degree.trim()) {
        checkedCount++;
        if (!isPhraseContained(rawText, edu.degree)) {
          recordViolation(
            "education_or_degree",
            edu.degree,
            `education[${i}].degree`,
            `Extracted degree '${edu.degree}' does not appear in source resume text.`
          );
        }
      }
      if (typeof edu.year === "string" && edu.year.trim()) {
        checkedCount += checkDateValueSupport(
          edu.year,
          rawText,
          rawText,
          `education[${i}].year`,
          false,
          recordViolation
        );
      }
    }
  }

  // Certifications
  if (Array.isArray(extracted.certifications)) {
    for (let i = 0; i < extracted.certifications.length; i++) {
      const cert =
        typeof extracted.certifications[i] === "string"
          ? extracted.certifications[i].trim()
          : "";
      if (!cert) continue;
      checkedCount++;
      if (!isPhraseContained(rawText, cert) && !isCanonicalSkillSupported(cert, rawText, [])) {
        recordViolation(
          "certification",
          cert,
          `certifications[${i}]`,
          `Extracted certification '${cert}' is not evidenced in source resume text.`
        );
      }
    }
  }

  const relationsVerified: RelationVerificationStatus =
    expList.length === 0
      ? "not_applicable"
      : anySegmented && !anyUnsegmentedWithCompany
      ? "verified_segmented"
      : "unverified_unsegmented";

  const limitations =
    relationsVerified === "unverified_unsegmented"
      ? [
          ...DEFAULT_LIMITATIONS,
          "Could not unambiguously isolate every employer segment in rawText; entity relations across entries were checked at document level only.",
        ]
      : DEFAULT_LIMITATIONS;

  return buildReport("resume_extraction", violations, checkedCount, {
    relationsVerified,
    limitations,
  });
}

/**
 * Masks target `job.title` ONLY within greeting, subject/header, or explicit application-intent spans
 * (never globally across self-identification statements such as "I am a Kubernetes Engineer.").
 */
export function maskJobTitleInApplicationSpans(
  text: string,
  job: FaithfulnessJobContext | undefined
): string {
  const title = (job?.title || "").trim();
  if (!title || title.length <= 2) return text;

  const escapedTitle = escapeRegExp(title);
  let masked = text;

  // 1. Header / Subject / Salutation lines ("Re: Kubernetes Engineer", "Application for: Kubernetes Engineer")
  const headerSpanRegex = new RegExp(
    `((?:^|\\n)\\s*(?:Re|Subject|Position|Role|Application(?:\\s+for)?)\\s*:\\s*[^\\n]*?)${escapedTitle}`,
    "gi"
  );
  masked = masked.replace(headerSpanRegex, "$1 ");

  // 2. Application-intent verb phrases ("applying for the Kubernetes Engineer role", "interested in Kubernetes Engineer")
  const appIntentRegex = new RegExp(
    `(\\b(?:apply(?:ing)?\\s+(?:for|to)|application\\s+for|interested\\s+in|excited\\s+(?:about|to\\s+(?:apply\\s+for|be\\s+considered\\s+for))|thrilled\\s+to\\s+apply\\s+for|writing\\s+(?:regarding|about|to\\s+apply\\s+for)|candidate\\s+for|consideration\\s+for|(?:the|this)\\s+open(?:ing)?\\s+(?:for|of)|joining\\s+(?:you|the\\s+team)\\s+as)\\s+(?:the\\s+|an?\\s+)?)${escapedTitle}`,
    "gi"
  );
  masked = masked.replace(appIntentRegex, "$1 ");

  // 3. Explicit target-position noun phrases ("for your Kubernetes Engineer role/position/opening/opportunity")
  const targetRolePhraseRegex = new RegExp(
    `(\\b(?:your|the|this)\\s+)${escapedTitle}(\\s+(?:role|position|opening|opportunity)\\b)`,
    "gi"
  );
  masked = masked.replace(targetRolePhraseRegex, "$1 $2");

  return masked;
}

const CLAUSE_SPLIT_REGEX = /[.!?\n;]+|,?\s+(?:though|although|however|while|whereas|yet|but)\s+/;

const NEGATED_OR_LACK_CLAIM_REGEX =
  /\b(?:have\s+not|haven't|has\s+not|hasn't|had\s+not|hadn't|did\s+not|didn't|never|not\s+yet|don't\s+have|do\s+not\s+have|no\s+(?:prior\s+|direct\s+|hands-on\s+|production\s+|formal\s+)?(?:experience|background|exposure|expertise|proficiency)|unfamiliar\s+with|new\s+to|lack(?:s|ing)?\s+(?:experience|expertise|proficiency)\s+(?:in|with))\b/i;

const ASPIRATIONAL_LEARN_CUE_REGEX =
  /\b(?:want|eager|excited|keen|looking|ready|hoping|motivated|willing|plan(?:ning)?|aim(?:ing)?)\s+to\s+(?:learn|master|pick\s+up|explore|study|adopt|gain\s+experience\s+(?:in|with))\b|\bcurrently\s+(?:learning|studying|exploring)\b/i;

function splitSkillSubclausesForNegation(clause: string): string[] {
  return clause
    .split(/,?\s+(?:and|or)\s+(?=(?:i\s+|want|eager|excited|looking|ready|hoping|plan|aim|have|haven't|currently|never))/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isSkillNegatedOrAspirationalInSubclause(subclause: string, skillLower: string): boolean {
  if (!NEGATED_OR_LACK_CLAIM_REGEX.test(subclause) && !ASPIRATIONAL_LEARN_CUE_REGEX.test(subclause)) {
    return false;
  }

  // If subclause has explicit negation/disclaimer or learning intent tied to this skill, mark hedged.
  if (NEGATED_OR_LACK_CLAIM_REGEX.test(subclause)) {
    return true;
  }

  // Guard against "I used <skill> and want to learn..." inside the exact same short subclause:
  // require the aspirational/learning cue to precede or directly wrap the skill mention.
  const skillMatch = new RegExp(`(^|[^a-z0-9+#])${escapeRegExp(skillLower)}([^a-z0-9+#]|$)`, "i").exec(
    stripDisambiguatedTechCompounds(skillLower, subclause)
  );
  const learnMatch = ASPIRATIONAL_LEARN_CUE_REGEX.exec(subclause);
  if (!skillMatch || !learnMatch) return false;
  return learnMatch.index <= skillMatch.index;
}

/**
 * Verifies generated cover letter prose against verified `candidate` and target `job` payloads.
 * Keeps candidate numbers and JD numbers separate, restricts target company/title exemptions to
 * application context, and avoids false positives on negated/aspirational skill statements.
 */
export function verifyCoverLetterFaithfulness(
  letterText: string,
  candidate: Partial<CandidateProfile>,
  job: FaithfulnessJobContext = {}
): FaithfulnessReport {
  if (typeof letterText !== "string" || !letterText.trim()) {
    return buildReport("cover_letter", [], 0, {
      inconclusiveReasons: ["Cover letter output is missing or empty."],
    });
  }

  if (!isPlainRecord(candidate)) {
    return buildReport("cover_letter", [], 0, {
      inconclusiveReasons: ["Candidate profile source is missing or invalid."],
    });
  }

  const text = letterText.trim();
  const violations: UnverifiedClaim[] = [];
  const inconclusiveReasons: string[] = [];
  let checkedCount = 0;

  const cand = collectCandidateEvidence(candidate);
  const jobInfo = collectJobEvidence(job);
  const combinedSourceText = `${cand.text} ${jobInfo.text}`;

  // 1. Email, phone & external URL checks
  const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  for (const email of emails) {
    checkedCount++;
    if (!candidate.email || email.toLowerCase() !== candidate.email.toLowerCase().trim()) {
      violations.push({
        kind: "contact_or_link",
        claim: email,
        field: "letterText",
        reason: `Cover letter includes unverified email '${email}'.`,
        severity: "error",
      });
    }
  }

  const phones = text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || [];
  const candPhoneDigits = (candidate.phone || "").replace(/\D/g, "");
  for (const phone of phones) {
    checkedCount++;
    const foundDigits = phone.replace(/\D/g, "");
    if (!candPhoneDigits || foundDigits !== candPhoneDigits) {
      violations.push({
        kind: "contact_or_link",
        claim: phone,
        field: "letterText",
        reason: `Cover letter includes unverified phone '${phone}'.`,
        severity: "error",
      });
    }
  }

  const urls = text.match(/(?:https?:\/\/|www\.)[^\s)]+/gi) || [];
  for (const url of urls) {
    checkedCount++;
    if (!combinedSourceText.toLowerCase().includes(url.toLowerCase())) {
      violations.push({
        kind: "contact_or_link",
        claim: url,
        field: "letterText",
        reason: `Cover letter includes unverified URL '${url}' absent from source payload.`,
        severity: "error",
      });
    }
  }

  // 2. Skills claimed in prose (job title masked ONLY inside greeting/application spans; negated/aspirational clauses handled)
  const skillScanText = maskJobTitleInApplicationSpans(text, job);
  const proseClauses = skillScanText
    .split(CLAUSE_SPLIT_REGEX)
    .map((c) => c.trim())
    .filter(Boolean);

  for (const clause of proseClauses) {
    for (const subclause of splitSkillSubclausesForNegation(clause)) {
      for (const skill of extractTaxonomySkillsFromText(subclause)) {
        if (isCanonicalSkillSupported(skill, cand.text, cand.explicitSkills)) {
          checkedCount++;
          continue;
        }
        if (isSkillNegatedOrAspirationalInSubclause(subclause, skill)) {
          // Honest negation / desire-to-learn statement is not an unsupported capability claim.
          inconclusiveReasons.push(
            `Skipped negated/aspirational skill mention '${skill}' rather than counting it as a claimed skill.`
          );
          continue;
        }
        checkedCount++;
        violations.push({
          kind: "skill_or_tool",
          claim: skill,
          field: "letterText",
          reason: `Cover letter claims skill/tool '${skill}' not evidenced in candidate profile.`,
          severity: "error",
        });
      }
    }
  }

  // 3. Fresher / tenure & numeric claims (STRICT candidate numeric pool only — never launder JD numbers)
  const hasNoExperience = !candidate.experience || candidate.experience.length === 0;
  if (hasNoExperience) {
    if (
      /\b(?:\d+|\w+)\+?\s+years?\s+(?:of\s+)?experience\b/i.test(text) ||
      /\b(?:my\s+tenure|previous\s+(?:roles|employers|companies))\b/i.test(text)
    ) {
      checkedCount++;
      violations.push({
        kind: "experience_claim",
        claim: "prior work tenure / years of experience",
        field: "letterText",
        reason: "Cover letter claims years/tenure when candidate has 0 verified experience entries.",
        severity: "error",
      });
    }
  }

  // Strip formatted phone numbers so 10-digit parts aren't re-flagged as unverified metrics
  const textWithoutPhones = text.replace(
    /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
    " "
  );
  for (const num of extractNumericFactsFromText(textWithoutPhones)) {
    checkedCount++;
    if (!isNumericSupported(num, cand.numericSet)) {
      const inJobOnly = isNumericSupported(num, jobInfo.numericSet);
      violations.push({
        kind: "numeric_metric",
        claim: num,
        field: "letterText",
        reason: inJobOnly
          ? `Cover letter cites numeric metric '${num}' found only in the target job description (not evidenced in candidate profile).`
          : `Cover letter cites numeric fact '${num}' not evidenced in candidate profile.`,
        severity: "error",
      });
    }
  }

  // 4. Employer / academic institution mentions (strict employment cues require candidate organizations ONLY)
  for (const mention of extractOrganizationMentionsWithContext(text)) {
    checkedCount++;
    const matchedCandidate = cand.organizations.some(
      (org) => isPhraseContained(org, mention.org) || isPhraseContained(mention.org, org)
    );
    const matchedTargetRoleOrg =
      mention.isApplicationTargetContext &&
      Boolean(jobInfo.company) &&
      (isPhraseContained(jobInfo.company, mention.org) ||
        isPhraseContained(mention.org, jobInfo.company));

    if (!matchedCandidate && !matchedTargetRoleOrg) {
      const matchesJobCompany =
        Boolean(jobInfo.company) &&
        (isPhraseContained(jobInfo.company, mention.org) ||
          isPhraseContained(mention.org, jobInfo.company));
      violations.push({
        kind: "employer_or_organization",
        claim: mention.org,
        field: "letterText",
        reason: matchesJobCompany
          ? `Cover letter attributes '${mention.org}' as candidate employment/education history, but it is only the target job company.`
          : `Cover letter names organization '${mention.org}' not found in candidate employment/education history.`,
        severity: "error",
      });
    }
  }

  // If positive verifiable claims were checked and passed, negated disclaimers do not fail the letter.
  const effectiveInconclusive =
    checkedCount > 0 && violations.length === 0 ? [] : inconclusiveReasons;

  return buildReport("cover_letter", violations, checkedCount, {
    inconclusiveReasons: effectiveInconclusive,
  });
}

const GAP_OWNERSHIP_CLAUSE_REGEX =
  /\b(?:lacks?|lacking|missing|without|absent|gaps?\s+(?:in|around)|no\s+(?:evidenced?\s+|verified\s+|prior\s+|direct\s+)?(?:experience|expertise|background|proficiency|mention|skill)|not\s+(?:evidenced|present|found|listed|shown)\b|doesn't\s+have|does\s+not\s+have|needs?\s+to\s+learn|is\s+missing)\b/i;

const CANDIDATE_POSSESSION_CLAUSE_REGEX =
  /\b(?:candidate|applicant|you|your|they|their|he|she)\s+(?:has|have|brings?|possess(?:es)?|demonstrates?|shows?|offers?|worked\s+with|built|used|knows?|specializes?\s+in|excels?\s+in)\b|\b(?:proven|strong|solid|deep|extensive|direct|hands-on)\s+(?:experience|expertise|background|proficiency|skills?|knowledge)\s+(?:in|with)\b|\bmatched\s+skills?\b/i;

const JOB_REQUIREMENT_CLAUSE_REGEX =
  /\b(?:(?:the\s+)?(?:job|role|position|company|employer|jd|posting|description|listing|team)\s+(?:requires?|asks?\s+for|needs?|seeks?|prefers?|mentions?|lists?|looks?\s+for)|(?:required|requested|asked\s+for|mentioned)\s+(?:by|in)\s+(?:the\s+)?(?:job|role|position|jd|posting|description))\b/i;

type SummaryClauseOwnership = "candidate" | "gap" | "job_requirement";

function classifySummaryClauseOwnership(
  clause: string,
  jobCompany: string
): SummaryClauseOwnership {
  if (GAP_OWNERSHIP_CLAUSE_REGEX.test(clause)) {
    return "gap";
  }

  const hasCandPossession = CANDIDATE_POSSESSION_CLAUSE_REGEX.test(clause);
  if (hasCandPossession) {
    return "candidate";
  }

  if (JOB_REQUIREMENT_CLAUSE_REGEX.test(clause)) {
    return "job_requirement";
  }

  if (jobCompany && isPhraseContained(clause, jobCompany)) {
    if (/\b(?:requires?|seeks?|asks?\s+for|needs?|prefers?|hiring|looking\s+for)\b/i.test(clause)) {
      return "job_requirement";
    }
  }

  return "candidate";
}

/**
 * Verifies AI match explanation (`job_fit`) output against verified `candidate` and `job` payloads.
 * Enforces bidirectional skill consistency, clause-level subject ownership in `summary`,
 * separate candidate/job numeric & org attribution, and inconclusive on empty/missing outputs.
 */
export function verifyMatchExplanationFaithfulness(
  explanation: MatchExplanationOutput,
  candidate: Partial<CandidateProfile>,
  job: FaithfulnessJobContext
): FaithfulnessReport {
  if (!isPlainRecord(explanation)) {
    return buildReport("job_fit", [], 0, {
      inconclusiveReasons: ["Match explanation object is missing or invalid."],
    });
  }

  if (!isPlainRecord(candidate)) {
    return buildReport("job_fit", [], 0, {
      inconclusiveReasons: ["Candidate profile source is missing or invalid."],
    });
  }

  const violations: UnverifiedClaim[] = [];
  let checkedCount = 0;

  const cand = collectCandidateEvidence(candidate);
  const jobInfo = collectJobEvidence(job);

  // 1. matchedSkills[] must be evidenced in candidate AND relevant to job when job text is present
  const matchedSkills = Array.isArray(explanation.matchedSkills) ? explanation.matchedSkills : [];
  for (let i = 0; i < matchedSkills.length; i++) {
    const skill = typeof matchedSkills[i] === "string" ? matchedSkills[i].trim() : "";
    if (!skill) continue;
    checkedCount++;
    const inCandidate = isCanonicalSkillSupported(skill, cand.text, cand.explicitSkills);
    if (!inCandidate) {
      violations.push({
        kind: "skill_or_tool",
        claim: skill,
        field: `matchedSkills[${i}]`,
        reason: `Matched skill '${skill}' is not evidenced in candidate profile.`,
        severity: "error",
      });
      continue;
    }

    if (jobInfo.hasJobDetails) {
      const cleanedJobForSkill = stripDisambiguatedTechCompounds(skill.toLowerCase(), jobInfo.text);
      const inJob =
        isCanonicalSkillSupported(skill, jobInfo.text, []) ||
        isPhraseContained(cleanedJobForSkill, skill);
      if (!inJob) {
        violations.push({
          kind: "skill_or_tool",
          claim: skill,
          field: `matchedSkills[${i}]`,
          reason: `Matched skill '${skill}' is absent from the target job title/description.`,
          severity: "error",
        });
      }
    }
  }

  // 2. missingSkills[] must NOT already be evidenced in candidate, and must appear in job when supplied
  const missingSkills = Array.isArray(explanation.missingSkills) ? explanation.missingSkills : [];
  for (let i = 0; i < missingSkills.length; i++) {
    const skill = typeof missingSkills[i] === "string" ? missingSkills[i].trim() : "";
    if (!skill) continue;
    checkedCount++;

    if (isCanonicalSkillSupported(skill, cand.text, cand.explicitSkills)) {
      violations.push({
        kind: "skill_contradiction",
        claim: skill,
        field: `missingSkills[${i}]`,
        reason: `Gap '${skill}' contradicts candidate profile (skill is already evidenced).`,
        severity: "error",
      });
      continue;
    }

    if (jobInfo.hasJobDetails) {
      const cleanedJobForSkill = stripDisambiguatedTechCompounds(skill.toLowerCase(), jobInfo.text);
      const inJob =
        isCanonicalSkillSupported(skill, jobInfo.text, []) ||
        isPhraseContained(cleanedJobForSkill, skill);
      if (!inJob) {
        violations.push({
          kind: "skill_or_tool",
          claim: skill,
          field: `missingSkills[${i}]`,
          reason: `Missing skill '${skill}' is not requested in target job title/description.`,
          severity: "error",
        });
      }
    }
  }

  // 3. Summary prose containment with strict subject ownership (candidate vs gap vs job_requirement)
  const summary = typeof explanation.summary === "string" ? explanation.summary.trim() : "";
  if (summary) {
    const scoreToken =
      typeof explanation.score === "number" && !Number.isNaN(explanation.score)
        ? String(Math.round(explanation.score))
        : null;

    const clauses = summary
      .split(CLAUSE_SPLIT_REGEX)
      .map((c) => c.trim())
      .filter(Boolean);

    for (const clause of clauses) {
      const ownership = classifySummaryClauseOwnership(clause, jobInfo.company);

      for (const skill of extractTaxonomySkillsFromText(clause)) {
        checkedCount++;
        const inCand = isCanonicalSkillSupported(skill, cand.text, cand.explicitSkills);
        const inJob = isCanonicalSkillSupported(skill, jobInfo.text, []);

        if (ownership === "gap") {
          if (inCand) {
            violations.push({
              kind: "skill_contradiction",
              claim: skill,
              field: "summary",
              reason: `Explanation summary marks '${skill}' as a gap/missing, contradicting the candidate profile.`,
              severity: "error",
            });
          } else if (jobInfo.hasJobDetails && !inJob) {
            violations.push({
              kind: "skill_or_tool",
              claim: skill,
              field: "summary",
              reason: `Explanation summary cites missing skill '${skill}' absent from target job payload.`,
              severity: "error",
            });
          }
        } else if (ownership === "job_requirement") {
          if (!inJob) {
            violations.push({
              kind: "skill_or_tool",
              claim: skill,
              field: "summary",
              reason: `Explanation summary states job requirement '${skill}' not found in job payload.`,
              severity: "error",
            });
          }
        } else {
          // Candidate ownership / default: candidate MUST hold the skill (never satisfied solely by JD)
          if (!inCand) {
            violations.push({
              kind: "skill_or_tool",
              claim: skill,
              field: "summary",
              reason: inJob
                ? `Explanation summary attributes '${skill}' to candidate, but it appears only in target job requirements.`
                : `Explanation summary claims candidate skill '${skill}', absent from both candidate and job payloads.`,
              severity: "error",
            });
          }
        }
      }

      for (const num of extractNumericFactsFromText(clause)) {
        checkedCount++;
        const normalizedNoPct = num.replace(/%$/, "");
        const isEchoedScore =
          scoreToken !== null &&
          normalizedNoPct === scoreToken &&
          !new RegExp(`\\b${escapeRegExp(normalizedNoPct)}\\+?\\s*(?:years?|yrs?)\\b`, "i").test(
            clause
          );

        const allowedSet =
          ownership === "job_requirement" ? jobInfo.numericSet : cand.numericSet;

        if (!isEchoedScore && !isNumericSupported(num, allowedSet)) {
          violations.push({
            kind: "numeric_metric",
            claim: num,
            field: "summary",
            reason: `Explanation summary cites numeric fact '${num}' unsupported in the attributed payload.`,
            severity: "error",
          });
        }
      }
    }

    // Past-employment / study org cues belong strictly to candidate organizations
    for (const mention of extractOrganizationMentionsWithContext(summary)) {
      checkedCount++;
      const matchedCandidate = cand.organizations.some(
        (k) => isPhraseContained(k, mention.org) || isPhraseContained(mention.org, k)
      );
      const matchedTarget =
        mention.isApplicationTargetContext &&
        Boolean(jobInfo.company) &&
        (isPhraseContained(jobInfo.company, mention.org) ||
          isPhraseContained(mention.org, jobInfo.company));

      if (!matchedCandidate && !matchedTarget) {
        violations.push({
          kind: "employer_or_organization",
          claim: mention.org,
          field: "summary",
          reason: `Explanation summary attributes unverified organization '${mention.org}' to candidate history.`,
          severity: "error",
        });
      }
    }
  }

  return buildReport("job_fit", violations, checkedCount);
}

/**
 * Unified offline dispatcher routing each supported operation to its faithfulness verifier.
 */
export function verifyAiOutputFaithfulness(
  operation: FaithfulnessOperation,
  output: unknown,
  source: FaithfulnessSourceInput
): FaithfulnessReport {
  if (operation === "resume_extraction") {
    return verifyResumeExtractionFaithfulness(
      output as Partial<CandidateProfile>,
      typeof source?.rawText === "string" ? source.rawText : ""
    );
  }

  if (operation === "cover_letter") {
    return verifyCoverLetterFaithfulness(
      output as string,
      (source?.candidate ?? {}) as Partial<CandidateProfile>,
      source?.job || {}
    );
  }

  return verifyMatchExplanationFaithfulness(
    output as MatchExplanationOutput,
    (source?.candidate ?? {}) as Partial<CandidateProfile>,
    source?.job || {}
  );
}
