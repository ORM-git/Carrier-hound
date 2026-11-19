import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { getValidReturnUrl } from "@/lib/auth/session";
import fs from "fs";
import path from "path";

describe("Product Restore: Navigation, Redirects, and Safe Return URLs", () => {
  describe("Retired /dashboard URLs redirect to /jobs", () => {
    it("redirects /dashboard to /jobs with 301 in middleware", async () => {
      const req = new NextRequest("https://careermonke.com/dashboard");
      const res = await middleware(req);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("https://careermonke.com/jobs");
    });

    it("redirects /dashboard/ to /jobs with 301 in middleware", async () => {
      const req = new NextRequest("https://careermonke.com/dashboard/");
      const res = await middleware(req);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("https://careermonke.com/jobs");
    });

    it("redirects nested /dashboard subpaths (e.g. /dashboard/analytics) to /jobs with 301 in middleware", async () => {
      const req = new NextRequest("https://careermonke.com/dashboard/analytics");
      const res = await middleware(req);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("https://careermonke.com/jobs");
    });

    it("redirects /dashboard with query params to /jobs in middleware", async () => {
      const req = new NextRequest("https://careermonke.com/dashboard?tab=saved");
      const res = await middleware(req);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("https://careermonke.com/jobs");
    });

    it("configures static 301 redirect for /dashboard in public/_redirects", () => {
      const redirectsPath = path.resolve(process.cwd(), "public/_redirects");
      const content = fs.readFileSync(redirectsPath, "utf-8");
      expect(content).toMatch(/^\/dashboard\s+\/jobs\s+301!?/m);
      expect(content).toMatch(/^\/dashboard\/\*\s+\/jobs\s+301!?/m);
    });

    it("configures static 301 redirect for /dashboard in netlify.toml", () => {
      const tomlPath = path.resolve(process.cwd(), "netlify.toml");
      const content = fs.readFileSync(tomlPath, "utf-8");
      expect(content).toContain('from = "/dashboard"');
      expect(content).toContain('from = "/dashboard/*"');
      expect(content).toContain('to = "/jobs"');
    });
  });

  describe("Default login goes to Jobs", () => {
    it("returns /jobs when targetUrl is null, undefined, or empty", () => {
      expect(getValidReturnUrl(null)).toBe("/jobs");
      expect(getValidReturnUrl(undefined)).toBe("/jobs");
      expect(getValidReturnUrl("")).toBe("/jobs");
      expect(getValidReturnUrl("   ")).toBe("/jobs");
    });

    it("normalizes retired /dashboard return target to /jobs", () => {
      expect(getValidReturnUrl("/dashboard")).toBe("/jobs");
      expect(getValidReturnUrl("/dashboard/")).toBe("/jobs");
      expect(getValidReturnUrl("/dashboard/overview")).toBe("/jobs");
    });

    it("prevents auth loop redirects by defaulting to /jobs", () => {
      expect(getValidReturnUrl("/login")).toBe("/jobs");
      expect(getValidReturnUrl("/signup")).toBe("/jobs");
      expect(getValidReturnUrl("/auth")).toBe("/jobs");
      expect(getValidReturnUrl("/auth/callback")).toBe("/jobs");
      expect(getValidReturnUrl("/login?error=test")).toBe("/jobs");
    });
  });

  describe("Safe explicit returns", () => {
    it("preserves legitimate product destination paths", () => {
      expect(getValidReturnUrl("/tracker")).toBe("/tracker");
      expect(getValidReturnUrl("/resume")).toBe("/resume");
      expect(getValidReturnUrl("/profile")).toBe("/profile");
      expect(getValidReturnUrl("/settings")).toBe("/settings");
      expect(getValidReturnUrl("/worldwide")).toBe("/worldwide");
      expect(getValidReturnUrl("/pricing")).toBe("/pricing");
      expect(getValidReturnUrl("/jobs/11111111-2222-3333-4444-555555555555")).toBe(
        "/jobs/11111111-2222-3333-4444-555555555555"
      );
    });

    it("preserves safe query strings and search parameters on allowed routes", () => {
      expect(getValidReturnUrl("/jobs?q=frontend&location=remote")).toBe(
        "/jobs?q=frontend&location=remote"
      );
      expect(getValidReturnUrl("/tracker?status=applied")).toBe("/tracker?status=applied");
    });

    it("rejects open redirects, backslashes, protocol-relative, and encoded exploits", () => {
      expect(getValidReturnUrl("https://evil.example.com")).toBe("/jobs");
      expect(getValidReturnUrl("http://evil.example.com")).toBe("/jobs");
      expect(getValidReturnUrl("//evil.example.com")).toBe("/jobs");
      expect(getValidReturnUrl("/\\evil.example.com")).toBe("/jobs");
      expect(getValidReturnUrl("/%5cevil.example.com")).toBe("/jobs");
      expect(getValidReturnUrl("/%2fevil.example.com")).toBe("/jobs");
      expect(getValidReturnUrl("/%00evil.example.com")).toBe("/jobs");
      expect(getValidReturnUrl("/\x00evil.example.com")).toBe("/jobs");
      expect(getValidReturnUrl("javascript:alert(1)")).toBe("/jobs");
    });
  });
});
