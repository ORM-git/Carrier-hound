/**
 * Per-page metadata row: every public client page must receive segment
 * metadata from a server layout (client pages cannot export metadata
 * themselves), and the worldwide server page must export its own.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";

const SEGMENT_LAYOUTS = ["login", "signup", "pricing", "early-access", "radar", "job-detail"];

describe("per-page metadata", () => {
  for (const route of SEGMENT_LAYOUTS) {
    it(`src/app/${route}/layout.tsx exports title + description`, () => {
      const src = fs.readFileSync(`src/app/${route}/layout.tsx`, "utf8");
      expect(src).toContain("export const metadata");
      expect(src).toContain("title:");
      expect(src).toContain("description:");
      // Segment canonical + OG override the root "/" canonicalization.
      expect(src).toContain(`canonical: "/${route}"`);
      expect(src).toContain("openGraph:");
      expect(src).toContain(`url: "https://careermonke.com/${route}"`);
      // Server layout must stay a pass-through: no markup changes.
      expect(src).toContain("return children;");
    });
  }

  it("worldwide server page exports metadata with canonical + OG", () => {
    const src = fs.readFileSync("src/app/worldwide/page.tsx", "utf8");
    expect(src).toContain("export const metadata");
    expect(src).toContain('canonical: "/worldwide"');
    expect(src).toContain("openGraph:");
  });

  it("no public client page was converted to add metadata inline", () => {
    for (const route of SEGMENT_LAYOUTS) {
      const page = fs.readFileSync(`src/app/${route}/page.tsx`, "utf8");
      expect(page).not.toContain("export const metadata");
    }
  });
});
