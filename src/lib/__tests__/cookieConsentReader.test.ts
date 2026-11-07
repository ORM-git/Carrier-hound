// @vitest-environment jsdom
/**
 * Consent-gate consistency: every telemetry reader must agree with
 * CookieNotice. Consent is true only when the versioned record parses to
 * exactly true; corrupt, false, and newer-version payloads read as false.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readCookieConsent } from "../analytics/cookieConsent";
import { COOKIE_CONSENT_KEY } from "@/components/CookieNotice";

beforeEach(() => window.localStorage.clear());

describe("readCookieConsent", () => {
  it("is false when nothing is stored", () => {
    expect(readCookieConsent()).toBe(false);
  });

  it("is true for the current envelope with data true", () => {
    window.localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify({ v: 1, data: true }));
    expect(readCookieConsent()).toBe(true);
  });

  it("is false for the current envelope with data false", () => {
    window.localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify({ v: 1, data: false }));
    expect(readCookieConsent()).toBe(false);
  });

  it("is false for a corrupt payload", () => {
    window.localStorage.setItem(COOKIE_CONSENT_KEY, "{not json");
    expect(readCookieConsent()).toBe(false);
  });

  it("is false for an envelope written by a newer build", () => {
    window.localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify({ v: 2, data: true }));
    expect(readCookieConsent()).toBe(false);
  });

  it("migrates a legacy raw true (pre-versioning acknowledgment)", () => {
    window.localStorage.setItem(COOKIE_CONSENT_KEY, "true");
    expect(readCookieConsent()).toBe(true);
  });

  it("is false for legacy raw junk", () => {
    window.localStorage.setItem(COOKIE_CONSENT_KEY, "yes please");
    expect(readCookieConsent()).toBe(false);
  });
});
