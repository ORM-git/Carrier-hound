/**
 * Clean, single-column, ATS-parsed PDF document generator.
 * Produces parse-friendly, vector-sharp PDFs for Tailored Resumes and Cover Letters.
 */

import { CandidateProfile } from "./types";
import {
  sanitizeCandidateProfile,
  stripHtmlAndExecutableMarkup,
  sanitizeDownloadFilename,
} from "../security/xss";

interface PageConfig {
  margin: number;
  pageWidth: number;
  pageHeight: number;
  contentWidth: number;
  bottomLimit: number;
}

async function initPdfDoc(): Promise<{ doc: any; config: PageConfig }> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({
    orientation: "portrait",
    unit: "pt",
    format: "letter",
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40; // 40pt = ~0.55in

  return {
    doc,
    config: {
      margin,
      pageWidth,
      pageHeight,
      contentWidth: pageWidth - margin * 2,
      bottomLimit: pageHeight - margin,
    },
  };
}

/**
 * Generates and downloads an ATS-compliant, single-column PDF resume.
 * Adheres to Career-Ops ATS layout specifications:
 * - Single-column parsing guarantee
 * - Standard ATS headings
 * - Standard Helvetica typography
 * - Action-oriented bullet hierarchies
 */
export async function downloadAtsResumePdf(
  rawCandidate: CandidateProfile,
  customFilename?: string
): Promise<void> {
  if (typeof window === "undefined") return;
  const candidate = sanitizeCandidateProfile(rawCandidate);

  const { doc, config } = await initPdfDoc();
  let y = config.margin;

  const checkPageBreak = (neededHeight: number) => {
    if (y + neededHeight > config.bottomLimit) {
      doc.addPage();
      y = config.margin;
    }
  };

  const printSectionHeader = (title: string) => {
    checkPageBreak(35);
    y += 10;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(30, 41, 59); // Slate-800
    doc.text(title.toUpperCase(), config.margin, y);
    y += 4;

    // Clean horizontal divider
    doc.setDrawColor(203, 213, 225); // Slate-300
    doc.setLineWidth(0.75);
    doc.line(config.margin, y, config.margin + config.contentWidth, y);
    y += 12;
  };

  // 1. HEADER (Candidate Details)
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(15, 23, 42); // Slate-900
  const name = (candidate.name || "Candidate").trim().toUpperCase();
  doc.text(name, config.margin, y);
  y += 16;

  // Headline & Contact Line
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105); // Slate-600

  if (candidate.headline) {
    doc.setFont("helvetica", "bold");
    doc.text(candidate.headline, config.margin, y);
    doc.setFont("helvetica", "normal");
    y += 13;
  }

  const contactItems = [candidate.email, candidate.phone, candidate.location].filter(Boolean);
  if (contactItems.length > 0) {
    doc.text(contactItems.join("  |  "), config.margin, y);
    y += 12;
  }

  // 2. PROFESSIONAL SUMMARY
  if (candidate.summary) {
    printSectionHeader("Professional Summary");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(30, 41, 59);
    const summaryLines = doc.splitTextToSize(candidate.summary, config.contentWidth);
    for (const line of summaryLines) {
      checkPageBreak(13);
      doc.text(line, config.margin, y);
      y += 13;
    }
  }

  // 3. TECHNICAL SKILLS
  if (candidate.skills && candidate.skills.length > 0) {
    printSectionHeader("Technical Skills");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(30, 41, 59);

    const skillsString = candidate.skills.join("  *  ");
    const skillLines = doc.splitTextToSize(skillsString, config.contentWidth);
    for (const line of skillLines) {
      checkPageBreak(12);
      doc.text(line, config.margin, y);
      y += 12;
    }
  }

  // 4. PROFESSIONAL EXPERIENCE
  if (candidate.experience && candidate.experience.length > 0) {
    printSectionHeader("Professional Experience");

    for (const exp of candidate.experience) {
      checkPageBreak(25);
      // Role & Company
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(15, 23, 42);
      const titleLine = `${exp.role} - ${exp.company}`;
      doc.text(titleLine, config.margin, y);

      // Dates (right-aligned or next line)
      doc.setFont("helvetica", "italic");
      doc.setFontSize(8.5);
      doc.setTextColor(100, 116, 139);
      const dateText = `${exp.startDate} - ${exp.endDate}`;
      const dateWidth = doc.getTextWidth(dateText);
      doc.text(dateText, config.margin + config.contentWidth - dateWidth, y);
      y += 14;

      // Bullets
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(30, 41, 59);

      for (const bullet of exp.bullets || []) {
        const bulletIndent = 12;
        const bulletTextWidth = config.contentWidth - bulletIndent;
        const bulletLines = doc.splitTextToSize(bullet, bulletTextWidth);

        checkPageBreak(bulletLines.length * 12 + 4);
        doc.text("-", config.margin + 2, y);

        for (let i = 0; i < bulletLines.length; i++) {
          doc.text(bulletLines[i], config.margin + bulletIndent, y);
          y += 12;
        }
        y += 2;
      }
      y += 6;
    }
  }

  // 5. EDUCATION
  if (candidate.education && candidate.education.length > 0) {
    printSectionHeader("Education");
    for (const edu of candidate.education) {
      checkPageBreak(18);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9.5);
      doc.setTextColor(15, 23, 42);
      doc.text(`${edu.degree} - ${edu.institution}`, config.margin, y);

      if (edu.year) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(100, 116, 139);
        const yrText = `(${edu.year})`;
        const yrWidth = doc.getTextWidth(yrText);
        doc.text(yrText, config.margin + config.contentWidth - yrWidth, y);
      }
      y += 14;
    }
  }

  // 6. CERTIFICATIONS
  if (candidate.certifications && candidate.certifications.length > 0) {
    printSectionHeader("Certifications");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(30, 41, 59);
    for (const cert of candidate.certifications) {
      checkPageBreak(14);
      doc.text(`- ${cert}`, config.margin, y);
      y += 13;
    }
  }

  const safeBase = sanitizeDownloadFilename(candidate.name, "Resume");
  const filename = customFilename ? sanitizeDownloadFilename(customFilename, `${safeBase}_ATS.pdf`) : `${safeBase}_ATS.pdf`;
  doc.save(filename);
}

/**
 * Generates and downloads a clean, professional PDF Cover Letter.
 * Adapted from Career-Ops Cover Letter styling.
 */
export async function downloadCoverLetterPdf(rawData: {
  candidate: CandidateProfile;
  company: string;
  jobTitle: string;
  content: string;
  customFilename?: string;
}): Promise<void> {
  if (typeof window === "undefined") return;
  const data = {
    ...rawData,
    candidate: sanitizeCandidateProfile(rawData.candidate),
    company: stripHtmlAndExecutableMarkup(rawData.company),
    jobTitle: stripHtmlAndExecutableMarkup(rawData.jobTitle),
    content: stripHtmlAndExecutableMarkup(rawData.content),
  };

  const { doc, config } = await initPdfDoc();
  let y = config.margin;

  const checkPageBreak = (neededHeight: number) => {
    if (y + neededHeight > config.bottomLimit) {
      doc.addPage();
      y = config.margin;
    }
  };

  // 1. Header (Candidate Contact Block)
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(15, 23, 42);
  const name = (data.candidate.name || "Candidate").trim();
  doc.text(name, config.margin, y);
  y += 15;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);

  const contactItems = [data.candidate.email, data.candidate.phone, data.candidate.location].filter(Boolean);
  if (contactItems.length > 0) {
    doc.text(contactItems.join("  |  "), config.margin, y);
    y += 12;
  }

  // Divider
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.75);
  doc.line(config.margin, y, config.margin + config.contentWidth, y);
  y += 16;

  // 2. Date
  const dateFormatted = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(dateFormatted, config.margin, y);
  y += 16;

  // 3. Recipient Info
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(15, 23, 42);
  doc.text(`Hiring Team`, config.margin, y);
  y += 12;
  doc.setFont("helvetica", "normal");
  doc.text(data.company, config.margin, y);
  y += 12;
  doc.text(`Application for: ${data.jobTitle}`, config.margin, y);
  y += 18;

  // 4. Body Content
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(30, 41, 59);

  // Split content by double newlines or paragraph blocks
  const rawParagraphs = data.content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  for (const para of rawParagraphs) {
    // If the paragraph starts with Salutation like "Dear Hiring Team,"
    if (/^dear\s+/i.test(para)) {
      doc.setFont("helvetica", "bold");
      doc.text(para, config.margin, y);
      doc.setFont("helvetica", "normal");
      y += 16;
      continue;
    }

    const lines = doc.splitTextToSize(para, config.contentWidth);
    checkPageBreak(lines.length * 14 + 10);

    for (const line of lines) {
      doc.text(line, config.margin, y);
      y += 14;
    }
    y += 10; // Space between paragraphs
  }

  // 5. Sign-off if not present in text
  if (!/sincerely|best regards|warm regards/i.test(data.content)) {
    checkPageBreak(40);
    y += 6;
    doc.text("Sincerely,", config.margin, y);
    y += 16;
    doc.setFont("helvetica", "bold");
    doc.text(name, config.margin, y);
  }

  const filename = data.customFilename
    ? sanitizeDownloadFilename(data.customFilename, "Cover_Letter.pdf")
    : `Cover_Letter_${sanitizeDownloadFilename(data.company, "Company")}_${sanitizeDownloadFilename(data.jobTitle, "Role")}.pdf`;

  doc.save(filename);
}
