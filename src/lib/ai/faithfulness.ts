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
  | "experience_claim";

export interface UnverifiedClaim {
  kind: FaithfulnessClaimKind;
  claim: string;
  field: string;
  reason: string;
  severity: FaithfulnessSeverity;
}

export interface FaithfulnessReport {
  faithful: boolean;
  operation: FaithfulnessOperation;
  violations: UnverifiedClaim[];
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

const CANONICAL_SKILL_LIST: string[] = Array.from(
  new Set([
    ...SKILLS_TAXONOMY.map((s) => s.toLowerCase().trim()),
    ...Object.keys(GENUINE_SKILL_ALIASES),
    ...Object.values(GENUINE_SKILL_ALIASES).flat(),
  ])
)
  .filter((s) => s.length > 1)
  .sort((a, b) => b.length - a.length);

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

/**
 * Extracts organization names mentioned after common employment or education cues.
 */
export function extractOrganizationMentions(text: string | null | undefined): string[] {
  if (!text || typeof text !== "string") return [];
  const pattern =
    /\b(?:worked\s+at|employed\s+at|tenure\s+at|experience\s+at|years?\s+at|yrs?\s+at|formerly\s+(?:at|with)|prior\s+to\s+joining|engineer\s+at|developer\s+at|manager\s+at|lead\s+at|director\s+at|analyst\s+at|intern\s+at|graduated\s+from|studied\s+at)\s+([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,3})/g;
  const orgs: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const candidateOrg = match[1].trim().replace(/[.,;:!?]+$/, "");
    if (!candidateOrg) continue;
    const firstWord = candidateOrg.split(/\s+/)[0].toLowerCase();
    if (ENTITY_STOPWORDS.has(firstWord)) continue;
    orgs.push(candidateOrg);
  }
  return Array.from(new Set(orgs));
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
  checkedCount: number
): FaithfulnessReport {
  const errorCount = violations.filter((v) => v.severity === "error").length;
  const failedFieldClaims = violations.length;
  return {
    faithful: errorCount === 0,
    operation,
    violations,
    checkedCount,
    supportedCount: Math.max(0, checkedCount - failedFieldClaims),
  };
}

/**
 * Verifies extracted resume JSON facts against the uploaded raw resume text (`rawText`).
 * Rejects fabricated skills, companies, roles, dates, metrics, degrees, certifications, or contacts.
 */
export function verifyResumeExtractionFaithfulness(
  extracted: Partial<CandidateProfile>,
  rawText: string
): FaithfulnessReport {
  const violations: UnverifiedClaim[] = [];
  let checkedCount = 0;

  if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
    return buildReport(
      "resume_extraction",
      [
        {
          kind: "experience_claim",
          claim: "<empty source>",
          field: "rawText",
          reason: "Source rawText is missing; cannot verify extracted facts.",
          severity: "error",
        },
      ],
      1
    );
  }

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
  if (extracted.email && extracted.email.trim()) {
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

  if (extracted.phone && extracted.phone.trim()) {
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

  if (extracted.name && extracted.name.trim()) {
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
  for (let i = 0; i < (extracted.skills || []).length; i++) {
    const skill = (extracted.skills?.[i] || "").trim();
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

  // Headline & summary numeric + canonical skill containment
  for (const textField of ["headline", "summary"] as const) {
    const val = (extracted[textField] || "").trim();
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

  // Experience entries
  for (let i = 0; i < (extracted.experience || []).length; i++) {
    const exp = extracted.experience![i];
    if (!exp) continue;
    if (exp.company && exp.company.trim()) {
      checkedCount++;
      if (!isPhraseContained(rawText, exp.company)) {
        recordViolation(
          "employer_or_organization",
          exp.company,
          `experience[${i}].company`,
          `Extracted employer '${exp.company}' does not appear in source resume text.`
        );
      }
    }
    if (exp.role && exp.role.trim()) {
      checkedCount++;
      if (!isPhraseContained(rawText, exp.role)) {
        recordViolation(
          "role_or_title",
          exp.role,
          `experience[${i}].role`,
          `Extracted role '${exp.role}' is not evidenced in source resume text.`
        );
      }
    }
    for (const dateField of ["startDate", "endDate"] as const) {
      const dateVal = (exp[dateField] || "").trim();
      if (!dateVal) continue;
      const years = dateVal.match(/\b(?:19|20)\d{2}\b/g) || [];
      for (const year of years) {
        checkedCount++;
        if (!rawNumbers.has(year)) {
          recordViolation(
            "date_or_year",
            year,
            `experience[${i}].${dateField}`,
            `Extracted year '${year}' (${dateField}) does not appear in source resume text.`
          );
        }
      }
    }
    for (let b = 0; b < (exp.bullets || []).length; b++) {
      const bullet = (exp.bullets[b] || "").trim();
      if (!bullet) continue;
      for (const num of extractNumericFactsFromText(bullet)) {
        checkedCount++;
        if (!isNumericSupported(num, rawNumbers)) {
          recordViolation(
            "numeric_metric",
            num,
            `experience[${i}].bullets[${b}]`,
            `Extracted bullet metric '${num}' does not appear in source resume text.`
          );
        }
      }
      for (const skill of extractTaxonomySkillsFromText(bullet)) {
        checkedCount++;
        if (!isCanonicalSkillSupported(skill, rawText, [])) {
          recordViolation(
            "skill_or_tool",
            skill,
            `experience[${i}].bullets[${b}]`,
            `Extracted bullet claims tool/skill '${skill}' absent from source resume text.`
          );
        }
      }
    }
  }

  // Education entries
  for (let i = 0; i < (extracted.education || []).length; i++) {
    const edu = extracted.education![i];
    if (!edu) continue;
    if (edu.institution && edu.institution.trim()) {
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
    if (edu.degree && edu.degree.trim()) {
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
    if (edu.year && edu.year.trim()) {
      const years = edu.year.match(/\b(?:19|20)\d{2}\b/g) || [];
      for (const yr of years) {
        checkedCount++;
        if (!rawNumbers.has(yr)) {
          recordViolation(
            "date_or_year",
            yr,
            `education[${i}].year`,
            `Extracted graduation year '${yr}' does not appear in source resume text.`
          );
        }
      }
    }
  }

  // Certifications
  for (let i = 0; i < (extracted.certifications || []).length; i++) {
    const cert = (extracted.certifications?.[i] || "").trim();
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

  return buildReport("resume_extraction", violations, checkedCount);
}

function maskVerbatimJobHeaderSpans(
  text: string,
  job: FaithfulnessJobContext | undefined
): string {
  let masked = text;
  if (job?.title && job.title.trim().length > 2) {
    masked = masked.replace(new RegExp(escapeRegExp(job.title.trim()), "gi"), " ");
  }
  if (job?.company && job.company.trim().length > 1) {
    masked = masked.replace(new RegExp(escapeRegExp(job.company.trim()), "gi"), " ");
  }
  return masked;
}

/**
 * Verifies generated cover letter prose against verified `candidate` and target `job` payloads.
 */
export function verifyCoverLetterFaithfulness(
  letterText: string,
  candidate: Partial<CandidateProfile>,
  job: FaithfulnessJobContext = {}
): FaithfulnessReport {
  const violations: UnverifiedClaim[] = [];
  let checkedCount = 0;

  const text = (letterText || "").trim();
  if (!text) {
    return buildReport(
      "cover_letter",
      [
        {
          kind: "experience_claim",
          claim: "<empty letter>",
          field: "letterText",
          reason: "Cover letter output is empty.",
          severity: "error",
        },
      ],
      1
    );
  }

  const cand = collectCandidateEvidence(candidate);
  const jobInfo = collectJobEvidence(job);
  const combinedSourceText = `${cand.text} ${jobInfo.text}`;
  const combinedNumbers = new Set<string>([
    ...Array.from(cand.numericSet),
    ...Array.from(jobInfo.numericSet),
  ]);

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

  // 2. Skills claimed in body prose (outside verbatim job title/company greeting) must exist in candidate
  const skillScanText = maskVerbatimJobHeaderSpans(text, job);
  for (const skill of extractTaxonomySkillsFromText(skillScanText)) {
    checkedCount++;
    if (!isCanonicalSkillSupported(skill, cand.text, cand.explicitSkills)) {
      violations.push({
        kind: "skill_or_tool",
        claim: skill,
        field: "letterText",
        reason: `Cover letter claims skill/tool '${skill}' not evidenced in candidate profile.`,
        severity: "error",
      });
    }
  }

  // 3. Fresher / tenure & numeric claims
  const hasNoExperience = !candidate.experience || candidate.experience.length === 0;
  if (hasNoExperience) {
    checkedCount++;
    if (
      /\b(?:\d+|\w+)\+?\s+years?\s+(?:of\s+)?experience\b/i.test(text) ||
      /\b(?:my\s+tenure|previous\s+(?:roles|employers|companies))\b/i.test(text)
    ) {
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
    // Candidate experience duration ("N years") must come from candidate facts, never JD minimum requirements
    const yearsPhraseRegex = new RegExp(`\\b${escapeRegExp(num)}\\s*(?:years?|yrs?)\\b`, "i");
    const allowedSet = yearsPhraseRegex.test(textWithoutPhones) ? cand.numericSet : combinedNumbers;
    if (!isNumericSupported(num, allowedSet)) {
      violations.push({
        kind: "numeric_metric",
        claim: num,
        field: "letterText",
        reason: `Cover letter cites numeric fact '${num}' not evidenced in source payload.`,
        severity: "error",
      });
    }
  }

  // 4. Employer / academic institution mentions
  const knownOrgs = [...cand.organizations, ...(jobInfo.company ? [jobInfo.company] : [])];
  for (const mentionedOrg of extractOrganizationMentions(text)) {
    checkedCount++;
    const matched = knownOrgs.some(
      (org) => isPhraseContained(org, mentionedOrg) || isPhraseContained(mentionedOrg, org)
    );
    if (!matched) {
      violations.push({
        kind: "employer_or_organization",
        claim: mentionedOrg,
        field: "letterText",
        reason: `Cover letter names organization '${mentionedOrg}' not found in candidate or job payload.`,
        severity: "error",
      });
    }
  }

  return buildReport("cover_letter", violations, checkedCount);
}

/**
 * Verifies AI match explanation (`job_fit`) output against verified `candidate` and `job` payloads.
 * Enforces bidirectional skill consistency (matchedSkills & missingSkills) and grounded summary facts.
 */
export function verifyMatchExplanationFaithfulness(
  explanation: MatchExplanationOutput,
  candidate: Partial<CandidateProfile>,
  job: FaithfulnessJobContext
): FaithfulnessReport {
  const violations: UnverifiedClaim[] = [];
  let checkedCount = 0;

  const cand = collectCandidateEvidence(candidate);
  const jobInfo = collectJobEvidence(job);
  const combinedText = `${cand.text} ${jobInfo.text}`;
  const combinedNumbers = new Set<string>([
    ...Array.from(cand.numericSet),
    ...Array.from(jobInfo.numericSet),
  ]);

  // 1. matchedSkills[] must be evidenced in candidate AND relevant to job when job text is present
  for (let i = 0; i < (explanation.matchedSkills || []).length; i++) {
    const skill = (explanation.matchedSkills?.[i] || "").trim();
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
  for (let i = 0; i < (explanation.missingSkills || []).length; i++) {
    const skill = (explanation.missingSkills?.[i] || "").trim();
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

  // 3. Summary prose containment: skills, numbers, organizations
  const summary = (explanation.summary || "").trim();
  if (summary) {
    for (const skill of extractTaxonomySkillsFromText(summary)) {
      checkedCount++;
      const supported =
        isCanonicalSkillSupported(skill, cand.text, cand.explicitSkills) ||
        isCanonicalSkillSupported(skill, jobInfo.text, []);
      if (!supported) {
        violations.push({
          kind: "skill_or_tool",
          claim: skill,
          field: "summary",
          reason: `Explanation summary mentions '${skill}', absent from both candidate and job.`,
          severity: "error",
        });
      }
    }

    const scoreToken =
      typeof explanation.score === "number" && !Number.isNaN(explanation.score)
        ? String(Math.round(explanation.score))
        : null;

    for (const num of extractNumericFactsFromText(summary)) {
      checkedCount++;
      const normalizedNoPct = num.replace(/%$/, "");
      const isEchoedScore =
        scoreToken !== null &&
        normalizedNoPct === scoreToken &&
        !new RegExp(`\\b${escapeRegExp(normalizedNoPct)}\\+?\\s*(?:years?|yrs?)\\b`, "i").test(summary);

      if (!isEchoedScore && !isNumericSupported(num, combinedNumbers)) {
        violations.push({
          kind: "numeric_metric",
          claim: num,
          field: "summary",
          reason: `Explanation summary cites numeric fact '${num}' not present in candidate or job payload.`,
          severity: "error",
        });
      }
    }

    const knownOrgs = [...cand.organizations, ...(jobInfo.company ? [jobInfo.company] : [])];
    for (const org of extractOrganizationMentions(summary)) {
      checkedCount++;
      const matched =
        knownOrgs.some((k) => isPhraseContained(k, org) || isPhraseContained(org, k)) ||
        isPhraseContained(combinedText, org);
      if (!matched) {
        violations.push({
          kind: "employer_or_organization",
          claim: org,
          field: "summary",
          reason: `Explanation summary cites unverified organization '${org}'.`,
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
      (output && typeof output === "object" ? output : {}) as Partial<CandidateProfile>,
      source.rawText || ""
    );
  }

  if (operation === "cover_letter") {
    const letter = typeof output === "string" ? output : "";
    return verifyCoverLetterFaithfulness(letter, source.candidate || {}, source.job || {});
  }

  return verifyMatchExplanationFaithfulness(
    (output && typeof output === "object" ? output : {}) as MatchExplanationOutput,
    source.candidate || {},
    source.job || {}
  );
}
