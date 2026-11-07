// @vitest-environment jsdom
/**
 * Row 77 (UTM/campaign capture bridge): the early-access payload carries
 * first-touch attribution only when consent parsed true AND a captured
 * record exists. Consent false/corrupt/newer-version, or no captured
 * record, means the attribution field is omitted entirely.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { buildEarlyAccessPayload } from "../analytics/earlyAccessPayload";
import { COOKIE_CONSENT_KEY } from "@/components/CookieNotice";
import { ATTRIBUTION_STORAGE_KEY } from "../analytics/utm";

const SAMPLE = {
  utmSource: "newsletter",
  utmCampaign: "launch",
  referrer: "https://example.com/post",
  landingPath: "/",
  capturedAt: "2026-11-08T00:00:00.000Z",
};

function grantConsent() {
  window.localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify({ v: 1, data: true }));
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("buildEarlyAccessPayload", () => {
  it("attaches attribution when consent is true and a record exists", () => {
    grantConsent();
    window.sessionStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(SAMPLE));
    const body = buildEarlyAccessPayload("a@b.com", "");
    expect(body.email).toBe("a@b.com");
    expect(body.attribution).toEqual(SAMPLE);
  });

  it("omits attribution when consent is false", () => {
    window.localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify({ v: 1, data: false }));
    window.sessionStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(SAMPLE));
    expect("attribution" in buildEarlyAccessPayload("a@b.com", "")).toBe(false);
  });

  it("omits attribution when the consent record is corrupt", () => {
    window.localStorage.setItem(COOKIE_CONSENT_KEY, "{not json");
    window.sessionStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(SAMPLE));
    expect("attribution" in buildEarlyAccessPayload("a@b.com", "")).toBe(false);
  });

  it("omits attribution when consent was written by a newer build", () => {
    window.localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify({ v: 2, data: true }));
    window.sessionStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(SAMPLE));
    expect("attribution" in buildEarlyAccessPayload("a@b.com", "")).toBe(false);
  });

  it("omits attribution when no record was captured despite consent", () => {
    grantConsent();
    const body = buildEarlyAccessPayload("a@b.com", "");
    expect("attribution" in body).toBe(false);
    expect(body.email).toBe("a@b.com");
  });

  it("omits attribution when there is no consent record at all", () => {
    window.sessionStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(SAMPLE));
    expect("attribution" in buildEarlyAccessPayload("a@b.com", "")).toBe(false);
  });
});
