import { describe, it, expect } from "vitest";
import {
  formatAuthError,
  FRIENDLY_AUTH_RATE_LIMIT_SIGNUP,
  FRIENDLY_AUTH_RATE_LIMIT_LOGIN,
  FRIENDLY_AUTH_RATE_LIMIT_SIGNUP_GOOGLE,
  FRIENDLY_AUTH_RATE_LIMIT_LOGIN_GOOGLE,
} from "../auth/authErrors";

describe("formatAuthError", () => {
  it("returns empty string for null, undefined, or empty values", () => {
    expect(formatAuthError(null)).toBe("");
    expect(formatAuthError(undefined)).toBe("");
    expect(formatAuthError("")).toBe("");
  });

  it("maps raw 'email rate limit exceeded' to friendly message on signup without promising a few minutes", () => {
    const raw = "email rate limit exceeded";
    const formatted = formatAuthError(raw, true);
    expect(formatted).toBe(FRIENDLY_AUTH_RATE_LIMIT_SIGNUP);
    expect(formatted).not.toContain("few minutes");
    expect(formatted).toContain("try again later");
    expect(formatted).toContain("continue with Google");
  });

  it("maps raw 'email rate limit exceeded' to friendly message on login without promising a few minutes", () => {
    const raw = "email rate limit exceeded";
    const formatted = formatAuthError(raw, false);
    expect(formatted).toBe(FRIENDLY_AUTH_RATE_LIMIT_LOGIN);
    expect(formatted).not.toContain("few minutes");
    expect(formatted).toContain("try again later");
    expect(formatted).toContain("continue with Google");
  });

  it("never suggests 'continue with Google' when rate limit is encountered on Google OAuth flow", () => {
    const googleRaw = "429: Too many requests for Google sign-in";
    const onLogin = formatAuthError(googleRaw, false, true);
    expect(onLogin).toBe(FRIENDLY_AUTH_RATE_LIMIT_LOGIN_GOOGLE);
    expect(onLogin).not.toContain("continue with Google");
    expect(onLogin).not.toContain("few minutes");

    const onSignup = formatAuthError(googleRaw, true, true);
    expect(onSignup).toBe(FRIENDLY_AUTH_RATE_LIMIT_SIGNUP_GOOGLE);
    expect(onSignup).not.toContain("continue with Google");
    expect(onSignup).not.toContain("few minutes");
  });

  it("auto-detects google in error string and avoids suggesting Google", () => {
    const googleRaw = "Google OAuth provider rate limit reached";
    const result = formatAuthError(googleRaw, false, false);
    expect(result).toBe(FRIENDLY_AUTH_RATE_LIMIT_LOGIN_GOOGLE);
    expect(result).not.toContain("continue with Google");
  });

  it("maps over_email_send_rate_limit code to friendly message", () => {
    expect(formatAuthError("over_email_send_rate_limit", true)).toBe(
      FRIENDLY_AUTH_RATE_LIMIT_SIGNUP
    );
    expect(formatAuthError("over_email_send_rate_limit", false)).toBe(
      FRIENDLY_AUTH_RATE_LIMIT_LOGIN
    );
  });

  it("maps 'too many requests' and 429 status strings", () => {
    expect(formatAuthError("Error: 429 Too many requests", true)).toBe(
      FRIENDLY_AUTH_RATE_LIMIT_SIGNUP
    );
    expect(formatAuthError("rate limit reached", false)).toBe(
      FRIENDLY_AUTH_RATE_LIMIT_LOGIN
    );
  });

  it("preserves standard non-rate-limit error messages unchanged", () => {
    const standard = "Please enter a valid email address.";
    expect(formatAuthError(standard, true)).toBe(standard);
    expect(formatAuthError("User already registered", true)).toBe(
      "User already registered"
    );
  });
});
