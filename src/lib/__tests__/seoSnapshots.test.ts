/**
 * Snapshot tests for serialized SEO outputs (vitest built-in snapshots).
 * Catches accidental drift in sitemap/robots/JSON-LD shapes; intentional
 * changes update snapshots with `vitest run -u`.
 */
import { describe, it, expect } from "vitest";
import { getRootStructuredData, getBreadcrumbJsonLd } from "@/lib/seo/structuredData";
import sitemap from "@/app/sitemap";
import robots from "@/app/robots";

const SITE = "https://careermonke.com";

describe("SEO serialized output snapshots", () => {
  it("root JSON-LD graph is stable", () => {
    expect(getRootStructuredData(SITE)).toMatchSnapshot();
  });

  it("breadcrumb JSON-LD shape is stable", () => {
    const trail = [
      { name: "Home", path: "/" },
      { name: "Remote Jobs", path: "/remote" },
      { name: "Pricing", path: "/pricing" },
    ];
    expect(getBreadcrumbJsonLd(trail, SITE)).toMatchSnapshot();
  });

  it("sitemap route list is stable (volatile lastModified excluded)", () => {
    const normalized = sitemap().map(({ url, changeFrequency, priority }) => ({
      url,
      changeFrequency,
      priority,
    }));
    expect(normalized).toMatchSnapshot();
  });

  it("sitemap only exposes public routes", () => {
    const urls = sitemap().map((e) => e.url);
    const protectedSegments = ["/dashboard", "/jobs", "/resume", "/tracker", "/profile", "/radar", "/settings", "/applications", "/job-search", "/job-detail", "/onboarding"];
    for (const url of urls) {
      for (const seg of protectedSegments) {
        expect(url).not.toContain(seg);
      }
    }
  });

  it("robots output is stable", () => {
    expect(robots()).toMatchSnapshot();
  });
});
