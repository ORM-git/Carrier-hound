import type { CandidateProfile } from "../resume/types";

/**
 * Allowed protocols for external user/job links (apply URLs, company links, etc.)
 */
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Strips ASCII control characters (except standard whitespace \t, \n, \r).
 */
export function stripControlChars(input?: string | null): string {
  if (!input || typeof input !== "string") return "";
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * Escapes HTML special characters so untrusted text is rendered strictly as inert text
 * when interpolated into HTML/XML templates (e.g. .doc / .docx exports).
 */
export function escapeHtml(input?: string | null): string {
  if (!input || typeof input !== "string") return "";
  return stripControlChars(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Strips executable HTML/SVG/Script tags, inline event handlers, and dangerous URI schemes
 * from plain-text fields (job titles, descriptions, company names, resume text, cover letters, notes).
 */
export function stripHtmlAndExecutableMarkup(input?: string | null): string {
  if (!input || typeof input !== "string") return "";
  return stripControlChars(input)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*>/gi, "")
    .replace(/<\/?[a-zA-Z!/?][^>]*>/g, "")
    .replace(/\bon[a-z]{2,}\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(?:javascript|vbscript|data\s*:\s*text\/html)\s*:[^\s"'<>)]*/gi, "");
}

/**
 * Validates and normalizes an external URL (such as job.applyUrl or tracker applyUrl).
 * Strictly allows ONLY `http:`, `https:`, and `mailto:` protocols.
 * Rejects `javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, protocol-relative `//`, and malformed URLs.
 */
export function sanitizeExternalUrl(rawUrl?: string | null): string | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;

  // Strip control characters and leading/trailing whitespace
  const trimmed = rawUrl.replace(/[\x00-\x20\x7F]+/g, "").trim();
  if (!trimmed || trimmed === "#") return null;

  // Reject protocol-relative URLs
  if (trimmed.startsWith("//") || trimmed.startsWith("\\\\")) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(protocol)) {
      return null;
    }
    if ((protocol === "http:" || protocol === "https:") && !parsed.hostname) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Validates an internal application path (e.g. analytics page path on admin dashboard).
 * Must begin with a single `/` and not contain protocol schemes or HTML markup.
 */
export function sanitizeInternalPath(rawPath?: string | null): string {
  if (!rawPath || typeof rawPath !== "string") return "/";
  const cleaned = stripHtmlAndExecutableMarkup(rawPath).trim();
  if (!cleaned.startsWith("/") || cleaned.startsWith("//") || cleaned.startsWith("/\\")) {
    return "/";
  }
  if (/[\x00-\x20<>'"]/.test(cleaned)) {
    return "/";
  }
  return cleaned;
}

/**
 * Sanitizes a filename for client-side downloads (.pdf, .docx, .doc, .txt) or upload display.
 * Prevents HTML injection in filenames (`<img src=x onerror=alert(1)>.pdf`) and path traversal.
 */
export function sanitizeDownloadFilename(rawName?: string | null, fallback = "Document"): string {
  if (!rawName || typeof rawName !== "string") return fallback;
  const stripped = stripHtmlAndExecutableMarkup(rawName)
    .replace(/\.\.+/g, "_")
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
  return stripped || fallback;
}

/**
 * Sanitizes a job object for safe display on job cards, job detail, radar globe, and modals.
 */
export function sanitizeJobRecord<T extends Record<string, any>>(job: T): T {
  if (!job || typeof job !== "object") return job;
  const clone: Record<string, any> = { ...job };

  if (typeof clone.title === "string") {
    clone.title = stripHtmlAndExecutableMarkup(clone.title);
  }
  if (typeof clone.company === "string") {
    clone.company = stripHtmlAndExecutableMarkup(clone.company);
  }
  if (typeof clone.location === "string") {
    clone.location = stripHtmlAndExecutableMarkup(clone.location);
  }
  if (typeof clone.description === "string") {
    clone.description = stripHtmlAndExecutableMarkup(clone.description);
  }
  if (typeof clone.salary === "string") {
    clone.salary = stripHtmlAndExecutableMarkup(clone.salary);
  }
  if (typeof clone.salary_text === "string") {
    clone.salary_text = stripHtmlAndExecutableMarkup(clone.salary_text);
  }
  if (typeof clone.category === "string") {
    clone.category = stripHtmlAndExecutableMarkup(clone.category);
  }
  if (Array.isArray(clone.skills)) {
    clone.skills = clone.skills.map((s: any) =>
      typeof s === "string" ? stripHtmlAndExecutableMarkup(s) : String(s ?? "")
    );
  }
  if ("applyUrl" in clone) {
    clone.applyUrl = sanitizeExternalUrl(clone.applyUrl) || "";
  }
  if ("apply_url" in clone) {
    clone.apply_url = sanitizeExternalUrl(clone.apply_url) || "";
  }

  return clone as T;
}

/**
 * Sanitizes a tracker application record (title, company, location, salaryText, notes, applyUrl).
 */
export function sanitizeTrackerApplicationRecord<T extends Record<string, any>>(app: T): T {
  if (!app || typeof app !== "object") return app;
  const clone: Record<string, any> = { ...app };

  if (typeof clone.title === "string") {
    clone.title = stripHtmlAndExecutableMarkup(clone.title);
  }
  if (typeof clone.company === "string") {
    clone.company = stripHtmlAndExecutableMarkup(clone.company);
  }
  if (typeof clone.location === "string") {
    clone.location = stripHtmlAndExecutableMarkup(clone.location);
  }
  if (typeof clone.salaryText === "string") {
    clone.salaryText = stripHtmlAndExecutableMarkup(clone.salaryText);
  }
  if (typeof clone.notes === "string") {
    clone.notes = stripHtmlAndExecutableMarkup(clone.notes);
  }
  if ("applyUrl" in clone) {
    clone.applyUrl = sanitizeExternalUrl(clone.applyUrl) || undefined;
  }

  return clone as T;
}

/**
 * Sanitizes a CandidateProfile so resume preview, tailored resume, and exports never contain executable HTML/scripts.
 */
export function sanitizeCandidateProfile(profile: CandidateProfile): CandidateProfile {
  if (!profile || typeof profile !== "object") return profile;
  return {
    ...profile,
    name: stripHtmlAndExecutableMarkup(profile.name),
    email: stripHtmlAndExecutableMarkup(profile.email),
    phone: stripHtmlAndExecutableMarkup(profile.phone),
    location: stripHtmlAndExecutableMarkup(profile.location),
    headline: stripHtmlAndExecutableMarkup(profile.headline),
    summary: stripHtmlAndExecutableMarkup(profile.summary),
    rawText: typeof profile.rawText === "string" ? stripHtmlAndExecutableMarkup(profile.rawText) : profile.rawText,
    skills: Array.isArray(profile.skills)
      ? profile.skills.map((s) => stripHtmlAndExecutableMarkup(String(s || ""))).filter(Boolean)
      : [],
    experience: Array.isArray(profile.experience)
      ? profile.experience.map((exp) => ({
          ...exp,
          company: stripHtmlAndExecutableMarkup(exp.company),
          role: stripHtmlAndExecutableMarkup(exp.role),
          startDate: stripHtmlAndExecutableMarkup(exp.startDate),
          endDate: stripHtmlAndExecutableMarkup(exp.endDate),
          bullets: Array.isArray(exp.bullets)
            ? exp.bullets.map((b) => stripHtmlAndExecutableMarkup(String(b || ""))).filter(Boolean)
            : [],
        }))
      : [],
    education: Array.isArray(profile.education)
      ? profile.education.map((edu) => ({
          ...edu,
          degree: stripHtmlAndExecutableMarkup(edu.degree),
          institution: stripHtmlAndExecutableMarkup(edu.institution),
          year: stripHtmlAndExecutableMarkup(edu.year),
        }))
      : [],
    certifications: Array.isArray(profile.certifications)
      ? profile.certifications.map((c) => stripHtmlAndExecutableMarkup(String(c || ""))).filter(Boolean)
      : [],
  };
}

/**
 * Builds a Word-compatible HTML document string (.doc) for cover letter export
 * with strict HTML entity escaping on both title and body text.
 */
export function buildCoverLetterDocHtml(company: string, content: string): string {
  const safeCompany = escapeHtml(stripHtmlAndExecutableMarkup(company || "Company"));
  const safeBody = escapeHtml(stripHtmlAndExecutableMarkup(content || "")).replace(/\r?\n/g, "<br>");
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Cover Letter - ${safeCompany}</title>
<style>body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; line-height: 1.5; margin: 1in; white-space: pre-line; }</style>
</head>
<body>${safeBody}</body>
</html>`;
}
