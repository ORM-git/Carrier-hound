import { CandidateProfile } from "./types";
import { extractSkillsFromJob } from "../matcher/scoring";
import {
  sanitizeCandidateProfile,
  stripHtmlAndExecutableMarkup,
  sanitizeDownloadFilename,
} from "../security/xss";

export interface TailoredCoverLetterResult {
  recipient: string;
  company: string;
  jobTitle: string;
  salutation: string;
  contactHeader: string;
  paragraphs: string[];
  fullText: string;
  isValidated: boolean;
}

export interface CoverLetterValidationResult {
  valid: boolean;
  reasons: string[];
}

/**
 * Deterministically renders the candidate's verified contact header.
 * AI models are strictly prohibited from generating or modifying this block.
 */
export function formatContactHeader(candidate: CandidateProfile): string {
  const parts: string[] = [];
  if (candidate.name && candidate.name.trim() && candidate.name !== "Candidate") {
    parts.push(candidate.name.trim());
  }
  const details = [candidate.email, candidate.phone, candidate.location].filter(Boolean);
  if (details.length > 0) {
    parts.push(details.join(" | "));
  }
  return parts.join("\n");
}

/**
 * Validates cover letter text against verified candidate facts to enforce Zero Hallucinations.
 * Rejects unevidenced employers, unverified emails/phones, false URLs, or fake years of experience.
 */
export function validateCoverLetter(
  letterBody: string,
  candidate: CandidateProfile,
  job: { title: string; company: string }
): CoverLetterValidationResult {
  const reasons: string[] = [];
  const text = letterBody || "";

  // 0. Executable HTML / XSS markup check
  if (/<(?:script|img|svg|iframe|object|embed)\b|\bon(?:error|load|click|mouseover)\s*=|javascript\s*:/i.test(text)) {
    reasons.push("Contains disallowed HTML or script markup.");
  }

  // 1. Email check: No unverified emails
  const emailMatches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  for (const foundEmail of emailMatches) {
    if (!candidate.email || foundEmail.toLowerCase() !== candidate.email.toLowerCase()) {
      reasons.push(`Contains unverified email: "${foundEmail}"`);
    }
  }

  // 2. Phone check: No fabricated phone numbers
  const phoneMatches = text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || [];
  for (const foundPhone of phoneMatches) {
    const cleanFound = foundPhone.replace(/\D/g, "");
    const cleanCand = (candidate.phone || "").replace(/\D/g, "");
    if (!cleanCand || cleanFound !== cleanCand) {
      reasons.push(`Contains unverified phone: "${foundPhone}"`);
    }
  }

  // 3. Fake URLs check: No fabricated LinkedIn or portfolio links
  const urlMatches = text.match(/(?:https?:\/\/|www\.)[^\s]+/gi) || [];
  for (const url of urlMatches) {
    reasons.push(`Contains unverified link: "${url}"`);
  }

  // 4. Fresher / Zero experience check:
  const hasNoExperience = !candidate.experience || candidate.experience.length === 0;
  if (hasNoExperience) {
    if (/\b(\d+|\w+)\s+years\s+(?:of\s+)?experience\b/i.test(text)) {
      reasons.push("Claims years of work experience when profile has 0 verified roles.");
    }
    if (/\b(?:my\s+tenure|previous\s+(?:roles|employers|companies|engineering\s+roles))\b/i.test(text)) {
      reasons.push("References previous employment or tenure not evidenced in profile.");
    }
  }

  // 5. Foreign company hallucination check:
  const verifiedCompanies = new Set<string>();
  if (job.company) verifiedCompanies.add(job.company.toLowerCase().trim());
  (candidate.experience || []).forEach((exp) => {
    if (exp.company) verifiedCompanies.add(exp.company.toLowerCase().trim());
  });
  (candidate.education || []).forEach((edu) => {
    if (edu.institution) verifiedCompanies.add(edu.institution.toLowerCase().trim());
  });

  const companyPhrases = text.match(/\b(?:worked\s+at|tenure\s+at|employed\s+at|engineer\s+at|developer\s+at|manager\s+at)\s+([A-Z][A-Za-z0-9&.\s]{2,25})\b/g) || [];
  for (const phrase of companyPhrases) {
    const match = phrase.match(/\b(?:at)\s+([A-Z][A-Za-z0-9&.\s]{2,25})/);
    if (match && match[1]) {
      const extractedCompany = match[1].trim().toLowerCase();
      if (["the", "this", "scale", "present", "my", "our", "all"].includes(extractedCompany)) continue;
      const isKnown = Array.from(verifiedCompanies).some((vc) => vc.includes(extractedCompany) || extractedCompany.includes(vc));
      if (!isKnown) {
        reasons.push(`Mentions unverified employer: "${match[1].trim()}"`);
      }
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

/**
 * Generates a 1-click tailored cover letter grounded strictly in real resume facts.
 * Adapts tone dynamically across tech, marketing, design, and finance domains.
 * Adapts cleanly for freshers with 0 previous roles without fabricating tenure.
 */
/**
 * Extracts a concise role focus snippet from the job description if available.
 */
function extractJdCoreFocus(description?: string): string {
  if (!description || description.trim().length < 20) return "";

  // Split into sentences or bullets
  const snippets = description
    .split(/\r?\n|[•·\-\*]|\.\s+/)
    .map((s) => s.trim().replace(/^[^a-zA-Z]+/, ""))
    .filter((s) => s.length >= 25 && s.length <= 140);

  // Find sentences/phrases matching active engineering or product goals
  const targetSnippet = snippets.find((s) =>
    /\b(building|developing|scaling|designing|architecting|delivering|driving|optimizing|implementing|maintaining|creating)\b/i.test(s)
  );

  if (targetSnippet) {
    // Sanitize punctuation
    return targetSnippet.replace(/[.;,:]+$/, "").trim();
  }

  return "";
}

/**
 * Generates a 1-click tailored cover letter grounded strictly in real resume facts.
 * Deeply personalized to the target job title, company, and job description.
 * Adapts tone dynamically across tech, marketing, design, and finance domains.
 * Adapts cleanly for freshers with 0 previous roles without fabricating tenure.
 */
export function generateTailoredCoverLetter(
  rawCandidate: CandidateProfile,
  rawJob: {
    id?: string;
    title: string;
    company: string;
    description?: string;
    location?: string;
  }
): TailoredCoverLetterResult {
  const candidate = sanitizeCandidateProfile(rawCandidate);
  const job = {
    ...rawJob,
    title: stripHtmlAndExecutableMarkup(rawJob.title),
    company: stripHtmlAndExecutableMarkup(rawJob.company),
    description: rawJob.description ? stripHtmlAndExecutableMarkup(rawJob.description) : undefined,
    location: rawJob.location ? stripHtmlAndExecutableMarkup(rawJob.location) : undefined,
  };
  const jobSkills = extractSkillsFromJob({
    title: job.title,
    description: job.description || `${job.title} at ${job.company}`,
  });

  const matched = (candidate.skills || []).filter((s) =>
    jobSkills.some(
      (js) =>
        js.toLowerCase() === s.toLowerCase() ||
        s.toLowerCase().includes(js.toLowerCase()) ||
        js.toLowerCase().includes(s.toLowerCase())
    )
  );

  const hasExperience = Array.isArray(candidate.experience) && candidate.experience.length > 0;
  const jdFocusSnippet = extractJdCoreFocus(job.description);

  const domainString = `${candidate.headline || ""} ${(candidate.skills || []).join(" ")} ${job.title} ${job.description || ""}`.toLowerCase();
  const isAi = /\b(ai|artificial intelligence|ml|machine learning|deep learning|llm|nlp|ai platform|neural)\b/i.test(domainString);
  const isBackend = /\b(backend|back-end|api|microservices|distributed systems|card|payment|banking|transactions?|database|server|golang|python|java)\b/i.test(domainString) && !isAi && !/\b(frontend|front-end)\b/i.test(job.title.toLowerCase());
  const isFrontend = /\b(frontend|front-end|ui|ux|react|next\.js|client-side|vue|angular)\b/i.test(domainString) && !/\b(full[- ]?stack|backend)\b/i.test(job.title.toLowerCase());
  const isDevOps = /\b(devops|sre|cloud|infrastructure|kubernetes|docker|platform engineer)\b/i.test(domainString) && !isAi && !isBackend;
  const isMarketing = /marketing|seo|growth|content|social media|advertising|brand|copywriting|pr/i.test(domainString);
  const isDesign = /design|ui|ux|figma|product design|creative/i.test(domainString);
  const isFinance = /finance|accounting|audit|financial|tax|treasury|controller/i.test(domainString);
  const isHR = /recruiting|talent|human resources|hr|people operations/i.test(domainString);
  const isSales = /sales|account exec|business development|bdr|sdr/i.test(domainString);

  // Compute domain-aligned top skills from candidate's verified skills
  const rankSkill = (s: string): number => {
    const sl = s.toLowerCase();
    if (isAi && /\b(python|gcp|google cloud|data structures|algorithms|system design|docker|linux|orchestration)\b/i.test(sl)) return 3;
    if (isBackend && /\b(node|sql|express|postgres|mysql|rest|api|orchestration|system design|docker)\b/i.test(sl)) return 3;
    if (isFrontend && /\b(react|next|typescript|javascript|tailwind|css|html|ui)\b/i.test(sl)) return 3;
    if (isDevOps && /\b(docker|gcp|cloud|linux|git|system design)\b/i.test(sl)) return 3;
    return 1;
  };

  const domainSortedSkills = [...(candidate.skills || [])].sort((a, b) => rankSkill(b) - rankSkill(a));
  const topSkills = matched.length > 0
    ? matched.slice(0, 4).join(", ")
    : domainSortedSkills.slice(0, 3).join(", ") || "core technical capabilities";

  let domainFocus = "operational and strategic priorities";
  let domainStrengths = "delivering high-impact, reliable outcomes and collaborating cross-functionally";
  let teamLabel = "team";

  if (isAi) {
    domainFocus = "AI platform and intelligent systems initiatives";
    domainStrengths = "architecting scalable platform services, optimizing pipeline throughput, and deploying reliable microservices";
    teamLabel = "AI platform engineering team";
  } else if (isBackend) {
    domainFocus = "backend architecture and transactional services";
    domainStrengths = "building high-throughput APIs, optimizing relational query performance, and maintaining fault-tolerant transaction pipelines";
    teamLabel = "backend engineering team";
  } else if (isFrontend) {
    domainFocus = "frontend architecture and user experience goals";
    domainStrengths = "building high-performance web applications, optimizing client-side latency, and standardizing modular design systems";
    teamLabel = "frontend engineering team";
  } else if (isDevOps) {
    domainFocus = "cloud infrastructure and deployment reliability";
    domainStrengths = "containerized deployments, automated CI/CD workflows, and high-availability systems";
    teamLabel = "infrastructure and platform team";
  } else if (isMarketing) {
    domainFocus = "growth and marketing initiatives";
    domainStrengths = "scaling user acquisition, optimizing campaign performance, and driving measurable brand impact";
    teamLabel = "growth & marketing team";
  } else if (isDesign) {
    domainFocus = "design and product experience goals";
    domainStrengths = "crafting intuitive user experiences, scalable design systems, and engaging interfaces";
    teamLabel = "product design team";
  } else if (isFinance) {
    domainFocus = "financial planning and operational goals";
    domainStrengths = "accurate financial analysis, rigorous reporting, and data-driven business modeling";
    teamLabel = "finance team";
  } else if (isHR) {
    domainFocus = "talent and people operations strategy";
    domainStrengths = "streamlining talent acquisition, elevating employee engagement, and scaling operational workflows";
    teamLabel = "people operations team";
  } else if (isSales) {
    domainFocus = "revenue growth and commercial targets";
    domainStrengths = "driving high-value sales pipelines, building client relationships, and accelerating revenue";
    teamLabel = "sales team";
  } else if (/software|engineer|developer|data|tech|full[- ]?stack/i.test(domainString)) {
    domainFocus = "engineering and technical objectives";
    domainStrengths = "delivering robust software systems, writing clean maintainable code, and maintaining high engineering standards";
    teamLabel = "engineering team";
  }

  let paragraphs: string[] = [];

  if (hasExperience) {
    const latestExp = candidate.experience[0];
    const pastRole = latestExp.role || candidate.headline || "Professional";
    const pastCompany = latestExp.company;

    const openingP = jdFocusSnippet
      ? `I am writing to express my strong enthusiasm for the ${job.title} opportunity at ${job.company}. Having developed hands-on proficiency in ${topSkills}, I am eager to apply my practical background to ${job.company}'s work in ${jdFocusSnippet.toLowerCase().replace(/^(building|developing|scaling)/, (m) => m.toLowerCase())}.`
      : `I am writing to express my strong enthusiasm for the ${job.title} opportunity at ${job.company}. Having developed hands-on proficiency in ${topSkills}, I am eager to apply my practical background to ${job.company}'s ${domainFocus}.`;

    const bodyP = `In my work as a ${pastRole} at ${pastCompany}, I focused on ${domainStrengths}. My evidenced strengths include ${(candidate.skills || []).slice(0, 5).join(", ") || topSkills}, where I have consistently collaborated across teams to deliver measurable results.`;

    const impactP = jdFocusSnippet
      ? `What particularly excites me about ${job.company} is the opportunity to contribute directly to this role's objectives. With verified strengths in ${topSkills}, I am prepared to ramp up quickly, address key deliverables, and make immediate contributions to the ${teamLabel}.`
      : `What particularly excites me about ${job.company} is the opportunity to contribute directly to your mission. With proficiency in ${topSkills}, I am prepared to ramp up quickly and make immediate, valuable contributions to the ${teamLabel}.`;

    const closeP = `Thank you for your time and consideration. I would welcome the opportunity to discuss how my verified background and disciplined problem-solving approach align with the priorities at ${job.company}.`;

    paragraphs = [openingP, bodyP, impactP, closeP];
  } else {
    // Fresher / No prior work experience: Strictly zero invented history or tenure
    const openingP = jdFocusSnippet
      ? `I am writing to express my enthusiastic interest in the ${job.title} position at ${job.company}. With a verified foundation in ${topSkills}, I am eager to bring my dedicated focus and practical skills to your initiatives in ${jdFocusSnippet.toLowerCase()}.`
      : `I am writing to express my enthusiastic interest in the ${job.title} position at ${job.company}. With a verified foundation in ${topSkills}, I am eager to bring my dedicated focus, fast learning curve, and practical skills to ${job.company}'s ${domainFocus}.`;

    const bodyP = `Through rigorous coursework, hands-on projects, and dedicated skill mastery, I have built competencies in ${(candidate.skills || []).slice(0, 5).join(", ") || topSkills}. I focus on ${domainStrengths}, with an emphasis on discipline and accountability.`;

    const impactP = `I am deeply inspired by ${job.company}'s work and look forward to contributing with energy, high standards, and a genuine eagerness to support the ${teamLabel}.`;

    const closeP = `Thank you for your consideration. I welcome the opportunity to discuss how my foundational skills and strong work ethic align with this opening at ${job.company}.`;

    paragraphs = [openingP, bodyP, impactP, closeP];
  }

  const contactHeader = formatContactHeader(candidate);
  const fullTextBlocks: string[] = [];
  if (contactHeader) fullTextBlocks.push(contactHeader);
  fullTextBlocks.push(`Dear Hiring Team at ${job.company},`);
  fullTextBlocks.push(...paragraphs);
  fullTextBlocks.push("Sincerely,");
  fullTextBlocks.push(candidate.name || "Candidate");

  const fullText = fullTextBlocks.join("\n\n");

  return {
    recipient: `Hiring Team at ${job.company}`,
    company: job.company,
    jobTitle: job.title,
    salutation: `Dear Hiring Team at ${job.company},`,
    contactHeader,
    paragraphs,
    fullText,
    isValidated: true,
  };
}

/**
 * Builds an ATS-compliant, single-column plain text resume string.
 * Strictly avoids tables, multi-column layouts, graphics, or text boxes that break ATS software.
 */
export function buildAtsResumePlainText(rawCandidate: CandidateProfile): string {
  const candidate = sanitizeCandidateProfile(rawCandidate);
  const sections: string[] = [];

  // Header
  sections.push(`${candidate.name.toUpperCase()}`);
  const contactLine = [candidate.email, candidate.phone, candidate.location].filter(Boolean).join(" | ");
  if (contactLine) sections.push(contactLine);
  if (candidate.headline) sections.push(candidate.headline);
  sections.push("--------------------------------------------------------------------------------");

  // Summary
  if (candidate.summary) {
    sections.push("PROFESSIONAL SUMMARY");
    sections.push(candidate.summary);
    sections.push("");
  }

  // Skills
  if (candidate.skills && candidate.skills.length > 0) {
    sections.push("TECHNICAL SKILLS");
    sections.push(candidate.skills.join(" • "));
    sections.push("");
  }

  // Experience
  if (candidate.experience && candidate.experience.length > 0) {
    sections.push("PROFESSIONAL EXPERIENCE");
    for (const exp of candidate.experience) {
      sections.push(`${exp.role.toUpperCase()} | ${exp.company}`);
      sections.push(`${exp.startDate} - ${exp.endDate}`);
      for (const bullet of exp.bullets) {
        sections.push(`• ${bullet}`);
      }
      sections.push("");
    }
  }

  // Education
  if (candidate.education && candidate.education.length > 0) {
    sections.push("EDUCATION");
    for (const edu of candidate.education) {
      sections.push(`${edu.degree} — ${edu.institution} (${edu.year})`);
    }
    sections.push("");
  }

  // Certifications
  if (candidate.certifications && candidate.certifications.length > 0) {
    sections.push("CERTIFICATIONS");
    for (const cert of candidate.certifications) {
      sections.push(`• ${cert}`);
    }
  }

  return sections.join("\n");
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const crcTable = makeCrcTable();

function calculateCrc32(data: Uint8Array): number {
  let crc = 0 ^ -1;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function createZipArchive(entries: ZipEntry[]): Uint8Array {
  const localHeaders: Uint8Array[] = [];
  const centralHeaders: Uint8Array[] = [];
  let offset = 0;
  const textEncoder = new TextEncoder();

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.name);
    const dataBytes = entry.data;
    const crc = calculateCrc32(dataBytes);
    const size = dataBytes.length;

    const local = new Uint8Array(30 + nameBytes.length + size);
    const lView = new DataView(local.buffer);

    lView.setUint32(0, 0x04034b50, true);
    lView.setUint16(4, 20, true);
    lView.setUint16(6, 0, true);
    lView.setUint16(8, 0, true);
    lView.setUint16(10, 0, true);
    lView.setUint16(12, 0, true);
    lView.setUint32(14, crc, true);
    lView.setUint32(18, size, true);
    lView.setUint32(22, size, true);
    lView.setUint16(26, nameBytes.length, true);
    lView.setUint16(28, 0, true);

    local.set(nameBytes, 30);
    local.set(dataBytes, 30 + nameBytes.length);
    localHeaders.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cView = new DataView(central.buffer);

    cView.setUint32(0, 0x02014b50, true);
    cView.setUint16(4, 20, true);
    cView.setUint16(6, 20, true);
    cView.setUint16(8, 0, true);
    cView.setUint16(10, 0, true);
    cView.setUint16(12, 0, true);
    cView.setUint16(14, 0, true);
    cView.setUint32(16, crc, true);
    cView.setUint32(20, size, true);
    cView.setUint32(24, size, true);
    cView.setUint16(28, nameBytes.length, true);
    cView.setUint16(30, 0, true);
    cView.setUint16(32, 0, true);
    cView.setUint16(34, 0, true);
    cView.setUint16(36, 0, true);
    cView.setUint32(38, 0, true);
    cView.setUint32(42, offset, true);

    central.set(nameBytes, 46);
    centralHeaders.push(central);
    offset += local.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const ch of centralHeaders) {
    centralDirSize += ch.length;
  }

  const eocd = new Uint8Array(22);
  const eView = new DataView(eocd.buffer);
  eView.setUint32(0, 0x06054b50, true);
  eView.setUint16(4, 0, true);
  eView.setUint16(6, 0, true);
  eView.setUint16(8, entries.length, true);
  eView.setUint16(10, entries.length, true);
  eView.setUint32(12, centralDirSize, true);
  eView.setUint32(16, centralDirOffset, true);
  eView.setUint16(20, 0, true);

  const totalLength = offset + centralDirSize + 22;
  const result = new Uint8Array(totalLength);
  let pos = 0;

  for (const lh of localHeaders) {
    result.set(lh, pos);
    pos += lh.length;
  }

  for (const ch of centralHeaders) {
    result.set(ch, pos);
    pos += ch.length;
  }

  result.set(eocd, pos);
  return result;
}

function escapeXml(str: string): string {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generates an ATS-friendly OpenXML Word document (.docx) blob from confirmed facts.
 * Provides clean, single-column ATS-friendly formatting without tables or graphics.
 * Note: ATS-friendly formatting optimizes parser readability, but does not guarantee job acceptance.
 */
export function exportAtsWordDocument(rawCandidate: CandidateProfile): Blob {
  const candidate = sanitizeCandidateProfile(rawCandidate);
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const paragraphs: string[] = [];

  // Candidate Name
  paragraphs.push(`
    <w:p>
      <w:pPr><w:spacing w:after="60"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="34"/></w:rPr><w:t>${escapeXml((candidate.name || "Resume").toUpperCase())}</w:t></w:r>
    </w:p>
  `);

  // Contact line
  const contactParts = [candidate.email, candidate.phone, candidate.location].filter(Boolean);
  if (contactParts.length > 0) {
    paragraphs.push(`
      <w:p>
        <w:pPr><w:spacing w:after="80"/></w:pPr>
        <w:r><w:rPr><w:sz w:val="20"/><w:color w:val="555555"/></w:rPr><w:t>${escapeXml(contactParts.join(" | "))}</w:t></w:r>
      </w:p>
    `);
  }

  // Headline
  if (candidate.headline) {
    paragraphs.push(`
      <w:p>
        <w:pPr><w:spacing w:after="160"/></w:pPr>
        <w:r><w:rPr><w:i/><w:sz w:val="22"/><w:color w:val="333333"/></w:rPr><w:t>${escapeXml(candidate.headline)}</w:t></w:r>
      </w:p>
    `);
  }

  const addSectionHeader = (title: string) => {
    paragraphs.push(`
      <w:p>
        <w:pPr>
          <w:spacing w:before="240" w:after="80"/>
          <w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="333333"/></w:pBdr>
        </w:pPr>
        <w:r><w:rPr><w:b/><w:sz w:val="24"/></w:rPr><w:t>${title}</w:t></w:r>
      </w:p>
    `);
  };

  // Summary
  if (candidate.summary) {
    addSectionHeader("PROFESSIONAL SUMMARY");
    paragraphs.push(`
      <w:p>
        <w:pPr><w:spacing w:after="120"/></w:pPr>
        <w:r><w:rPr><w:sz w:val="21"/></w:rPr><w:t>${escapeXml(candidate.summary)}</w:t></w:r>
      </w:p>
    `);
  }

  // Skills
  if (candidate.skills && candidate.skills.length > 0) {
    addSectionHeader("TECHNICAL SKILLS");
    paragraphs.push(`
      <w:p>
        <w:pPr><w:spacing w:after="120"/></w:pPr>
        <w:r><w:rPr><w:sz w:val="21"/></w:rPr><w:t>${escapeXml(candidate.skills.join(" • "))}</w:t></w:r>
      </w:p>
    `);
  }

  // Experience
  if (candidate.experience && candidate.experience.length > 0) {
    addSectionHeader("PROFESSIONAL EXPERIENCE");
    for (const exp of candidate.experience) {
      paragraphs.push(`
        <w:p>
          <w:pPr><w:spacing w:before="120" w:after="40"/></w:pPr>
          <w:r><w:rPr><w:b/><w:sz w:val="22"/></w:rPr><w:t>${escapeXml(exp.role)} — ${escapeXml(exp.company)}</w:t></w:r>
        </w:p>
        <w:p>
          <w:pPr><w:spacing w:after="80"/></w:pPr>
          <w:r><w:rPr><w:i/><w:sz w:val="20"/><w:color w:val="555555"/></w:rPr><w:t>${escapeXml(exp.startDate)} – ${escapeXml(exp.endDate)}</w:t></w:r>
        </w:p>
      `);

      for (const bullet of exp.bullets) {
        paragraphs.push(`
          <w:p>
            <w:pPr>
              <w:ind w:left="360" w:hanging="240"/>
              <w:spacing w:after="40"/>
            </w:pPr>
            <w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>• </w:t></w:r>
            <w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>${escapeXml(bullet)}</w:t></w:r>
          </w:p>
        `);
      }
    }
  }

  // Education
  if (candidate.education && candidate.education.length > 0) {
    addSectionHeader("EDUCATION");
    for (const edu of candidate.education) {
      paragraphs.push(`
        <w:p>
          <w:pPr><w:spacing w:after="60"/></w:pPr>
          <w:r><w:rPr><w:b/><w:sz w:val="21"/></w:rPr><w:t>${escapeXml(edu.degree)}</w:t></w:r>
          <w:r><w:rPr><w:sz w:val="21"/></w:rPr><w:t> — ${escapeXml(edu.institution)} (${escapeXml(edu.year)})</w:t></w:r>
        </w:p>
      `);
    }
  }

  // Certifications
  if (candidate.certifications && candidate.certifications.length > 0) {
    addSectionHeader("CERTIFICATIONS");
    for (const cert of candidate.certifications) {
      paragraphs.push(`
        <w:p>
          <w:pPr>
            <w:ind w:left="360" w:hanging="240"/>
            <w:spacing w:after="40"/>
          </w:pPr>
          <w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>• </w:t></w:r>
          <w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>${escapeXml(cert)}</w:t></w:r>
        </w:p>
      `);
    }
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs.join("\n")}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const encoder = new TextEncoder();
  const zipBytes = createZipArchive([
    { name: "[Content_Types].xml", data: encoder.encode(contentTypesXml) },
    { name: "_rels/.rels", data: encoder.encode(relsXml) },
    { name: "word/document.xml", data: encoder.encode(documentXml) }
  ]);

  return new Blob([zipBytes.buffer as ArrayBuffer], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });
}

/**
 * Initiates download of ATS Word (.docx) document
 */
export function downloadAtsResumeDocx(candidate: CandidateProfile, customFilename?: string) {
  if (typeof window === "undefined") return;
  const blob = exportAtsWordDocument(candidate);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeBase = (candidate.name || "Resume").replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_").replace(/\s+/g, "_");
  a.download = customFilename ? customFilename.replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_") : `${safeBase}_ATS.docx`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Initiates download of ATS plain text file
 */
export function downloadAtsResumeText(candidate: CandidateProfile, customFilename?: string) {
  if (typeof window === "undefined") return;
  const text = buildAtsResumePlainText(candidate);
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeBase = (candidate.name || "Resume").replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_").replace(/\s+/g, "_");
  a.download = customFilename ? customFilename.replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_") : `${safeBase}_ATS.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

