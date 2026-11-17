/**
 * src/lib/onboarding/step2.ts
 *
 * Core validation and normalization for Onboarding Step 2:
 * 1. LinkedIn URL validation and canonical normalization (linkedin.com/in/...)
 * 2. Re-exports for resume processing helpers
 */

export const MAX_RESUME_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

export interface LinkedInValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  slug?: string;
  error?: string;
}

/**
 * Validates and normalizes a LinkedIn profile URL format.
 * Format requirement: must be a profile URL (linkedin.com/in/...).
 * Rejects non-profile pages (/company/, /feed/, /jobs/, etc.) and malicious or non-LinkedIn domains.
 */
export function validateAndNormalizeLinkedInUrl(rawUrl: string): LinkedInValidationResult {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { valid: false, error: "Please enter a LinkedIn profile URL." };
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "LinkedIn URL cannot be empty." };
  }

  if (trimmed.length > 300) {
    return { valid: false, error: "LinkedIn URL exceeds maximum length (300 characters)." };
  }

  let candidateUrl = trimmed;
  if (!/^https?:\/\//i.test(candidateUrl)) {
    candidateUrl = `https://${candidateUrl}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidateUrl);
  } catch {
    return { valid: false, error: "Invalid URL format. Please enter a valid URL." };
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLinkedInHost =
    hostname === "linkedin.com" ||
    hostname === "www.linkedin.com" ||
    /^[a-z]{2,3}\.linkedin\.com$/.test(hostname);

  if (!isLinkedInHost) {
    return {
      valid: false,
      error: "URL must be on linkedin.com (e.g. https://www.linkedin.com/in/username).",
    };
  }

  const pathname = parsed.pathname.replace(/\/+/g, "/");
  const inPrefixMatch = pathname.match(/^\/in\/([^/]+)/i);

  if (!inPrefixMatch) {
    return {
      valid: false,
      error: "URL must point to a personal profile (e.g. linkedin.com/in/yourname), not a company, job, or feed.",
    };
  }

  const rawSlug = inPrefixMatch[1].trim();

  if (!/^[a-zA-Z0-9_\-%\u0080-\uFFFF]+$/.test(rawSlug)) {
    return {
      valid: false,
      error: "Profile identifier contains invalid characters.",
    };
  }

  if (rawSlug.length < 3) {
    return {
      valid: false,
      error: "Profile identifier is too short (minimum 3 characters).",
    };
  }

  if (rawSlug.length > 100) {
    return {
      valid: false,
      error: "Profile identifier is too long (maximum 100 characters).",
    };
  }

  const normalizedUrl = `https://www.linkedin.com/in/${rawSlug}`;

  return {
    valid: true,
    normalizedUrl,
    slug: rawSlug,
  };
}

