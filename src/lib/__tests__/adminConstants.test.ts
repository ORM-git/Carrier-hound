import { afterEach, describe, expect, it } from "vitest";
import {
  ADMIN_EMAIL,
  getAdminEmailSet,
  hasAdminGoogleProvider,
  isEmailInAdminList,
  isUserEmailVerified,
  isVerifiedAdminUser,
} from "../admin/constants";
import { cn } from "../utils";

describe("admin/constants & utils", () => {
  const originalEnv = process.env.ADMIN_EMAILS;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ADMIN_EMAILS = originalEnv;
    } else {
      delete process.env.ADMIN_EMAILS;
    }
  });

  describe("getAdminEmailSet & isEmailInAdminList", () => {
    it("always includes ADMIN_EMAIL", () => {
      const set = getAdminEmailSet();
      expect(set.has(ADMIN_EMAIL.toLowerCase())).toBe(true);
      expect(isEmailInAdminList(ADMIN_EMAIL)).toBe(true);
      expect(isEmailInAdminList(` ${ADMIN_EMAIL.toUpperCase()} `)).toBe(true);
    });

    it("parses comma-separated ADMIN_EMAILS environment variable", () => {
      process.env.ADMIN_EMAILS = "ops@careermonke.com, lead@careermonke.com ";
      const set = getAdminEmailSet();
      expect(set.has("ops@careermonke.com")).toBe(true);
      expect(set.has("lead@careermonke.com")).toBe(true);
      expect(isEmailInAdminList("ops@careermonke.com")).toBe(true);
      expect(isEmailInAdminList("other@example.com")).toBe(false);
    });

    it("returns false for empty or non-string inputs", () => {
      expect(isEmailInAdminList(null)).toBe(false);
      expect(isEmailInAdminList(undefined)).toBe(false);
      expect(isEmailInAdminList("")).toBe(false);
      expect(isEmailInAdminList("   ")).toBe(false);
    });
  });

  describe("isUserEmailVerified", () => {
    it("returns true when email_confirmed_at or confirmed_at is present", () => {
      expect(isUserEmailVerified({ email_confirmed_at: "2026-01-01T00:00:00Z" })).toBe(true);
      expect(isUserEmailVerified({ confirmed_at: "2026-01-01T00:00:00Z" })).toBe(true);
    });

    it("returns false when confirmation timestamps are missing or invalid", () => {
      expect(isUserEmailVerified(null)).toBe(false);
      expect(isUserEmailVerified({})).toBe(false);
      expect(isUserEmailVerified({ email_confirmed_at: "" })).toBe(false);
      expect(isUserEmailVerified({ email_confirmed_at: "   " })).toBe(false);
    });
  });

  describe("hasAdminGoogleProvider", () => {
    it("detects google provider in app_metadata or identities", () => {
      expect(hasAdminGoogleProvider({ app_metadata: { provider: "google" } })).toBe(true);
      expect(hasAdminGoogleProvider({ app_metadata: { providers: ["github", "google"] } })).toBe(true);
      expect(hasAdminGoogleProvider({ identities: [{ provider: "google" }] })).toBe(true);
    });

    it("returns false when google is not present", () => {
      expect(hasAdminGoogleProvider(null)).toBe(false);
      expect(hasAdminGoogleProvider({ app_metadata: { provider: "email" } })).toBe(false);
      expect(hasAdminGoogleProvider({ identities: [{ provider: "github" }] })).toBe(false);
    });
  });

  describe("isVerifiedAdminUser", () => {
    it("returns true only when user meets all three criteria", () => {
      const validAdmin = {
        email: ADMIN_EMAIL,
        email_confirmed_at: "2026-01-01T00:00:00Z",
        app_metadata: { provider: "google" },
      };
      expect(isVerifiedAdminUser(validAdmin)).toBe(true);
    });

    it("returns false if email is not admin, unconfirmed, or lacks google provider", () => {
      expect(isVerifiedAdminUser(null)).toBe(false);
      expect(
        isVerifiedAdminUser({
          email: "stranger@example.com",
          email_confirmed_at: "2026-01-01T00:00:00Z",
          app_metadata: { provider: "google" },
        })
      ).toBe(false);
      expect(
        isVerifiedAdminUser({
          email: ADMIN_EMAIL,
          app_metadata: { provider: "google" },
        })
      ).toBe(false);
      expect(
        isVerifiedAdminUser({
          email: ADMIN_EMAIL,
          email_confirmed_at: "2026-01-01T00:00:00Z",
          app_metadata: { provider: "email" },
        })
      ).toBe(false);
    });
  });

  describe("utils: cn", () => {
    it("merges class names and handles conditionals correctly", () => {
      expect(cn("px-2 py-1", "bg-blue-500")).toBe("px-2 py-1 bg-blue-500");
      expect(cn("px-2", false && "hidden", "py-2")).toBe("px-2 py-2");
      expect(cn("p-4", "p-2")).toBe("p-2");
    });
  });
});
