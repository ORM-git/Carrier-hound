export const EMAIL_REGEX =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export const GENERIC_SUCCESS_MESSAGE = "You're on the list";
export const GENERIC_TRY_AGAIN_MESSAGE = "Could not save your email right now. Please try again.";

export function validateNotifyMeEmail(raw: unknown): {
  valid: boolean;
  email: string;
  error?: string;
} {
  if (typeof raw !== "string") {
    return { valid: false, email: "", error: "Please enter a valid email address." };
  }

  // Reject CRLF, null byte, or percent-encoded CR/LF injection attempts
  if (/[\r\n\0]/.test(raw) || /%0[ad]/i.test(raw)) {
    return { valid: false, email: "", error: "Please enter a valid email address." };
  }

  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return { valid: false, email: "", error: "Please enter your email address." };
  }

  if (
    normalized.length < 5 ||
    normalized.length > 254 ||
    normalized.includes("..") ||
    /\s/.test(normalized) ||
    !EMAIL_REGEX.test(normalized)
  ) {
    return { valid: false, email: normalized, error: "Please enter a valid email address." };
  }

  const [localPart, domainPart] = normalized.split("@");
  if (
    !localPart ||
    !domainPart ||
    localPart.length > 64 ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    !domainPart.includes(".") ||
    domainPart.startsWith(".") ||
    domainPart.endsWith(".")
  ) {
    return { valid: false, email: normalized, error: "Please enter a valid email address." };
  }

  return { valid: true, email: normalized };
}
