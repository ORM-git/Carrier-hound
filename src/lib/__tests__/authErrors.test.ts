import { describe, it, expect } from "vitest";
import {
  formatAuthError,
  FRIENDLY_AUTH_RATE_LIMIT_SIGNUP,
  FRIENDLY_AUTH_RATE_LIMIT_LOGIN,
} from "../auth/authErrors";

describe("formatAuthError", () => {
  it("returns empty string for null, undefined, or empty values", () => {
    expect(formatAuthError(null)).toBe("");
    expect(formatAuthError(undefined)).toBe("");
    expect(formatAuthError("")).toBe("");
  });

  it("maps raw 'email rate limit exceeded' to friendly message on signup", () => {
    const raw = "email rate limit exceeded";
    expect(formatAuthError(raw, true)).toBe(FRIENDLY_AUTH_RATE_LIMIT_SIGNUP);
  });

  it("maps raw 'email rate limit exceeded' to friendly message on login", () => {
    const raw = "email rate limit exceeded";
    expect(formatAuthError(raw, false)).toBe(FRIENDLY_AUTH_RATE_LIMIT_LOGIN);
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
