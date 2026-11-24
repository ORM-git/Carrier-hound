/**
 * src/lib/onboarding/step2.ts
 *
 * LinkedIn profile URL validation and normalization for onboarding step 2.
 * Validation only: nothing here (or anywhere in onboarding) fetches or scrapes LinkedIn.
 */

export interface LinkedInValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  handle?: string;
  error?: string;
}

const ALLOWED_HOSTS = new Set(["linkedin.com", "www.linkedin.com"]);
// LinkedIn public handles: letters, digits and hyphens (3-100 chars).
const HANDLE_RE = /^[A-Za-z0-9-]{3,100}$/;

/**
 * Accepts only https://linkedin.com/in/<handle> or https://www.linkedin.com/in/<handle>
 * (optional trailing slash; query and fragment are dropped). A bare "linkedin.com/in/x"
 * is treated as https. Returns the canonical https://www.linkedin.com/in/<handle>.
 */
export function validateAndNormalizeLinkedInUrl(rawUrl: unknown): LinkedInValidationResult {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    return { valid: false, error: "Please enter your LinkedIn profile URL." };
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length > 300) {
    return { valid: false, error: "That URL is too long." };
  }

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  if (hasScheme && !/^https:\/\//i.test(trimmed)) {
    return { valid: false, error: "LinkedIn URL must start with https://" };
  }

  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return { valid: false, error: "That doesn't look like a valid URL." };
  }

  if (parsed.username || parsed.password || parsed.port) {
    return { valid: false, error: "Please paste your plain LinkedIn profile URL." };
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    return { valid: false, error: "URL must be on linkedin.com." };
  }

  const match = parsed.pathname.match(/^\/in\/([^/]+)\/?$/);
  if (!match) {
    return {
      valid: false,
      error: "Use your personal LinkedIn profile URL, not a company, job or post URL.",
    };
  }
  const handle = match[1];
  if (!HANDLE_RE.test(handle)) {
    return { valid: false, error: "The profile name in that URL isn't valid." };
  }

  return { valid: true, handle, normalizedUrl: `https://www.linkedin.com/in/${handle}` };
}
