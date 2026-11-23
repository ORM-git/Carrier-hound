import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_BRAND, WORDMARK, wordmarkWidth } from "../AppBrand";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

describe("app brand tokens (owner V4: Electric primary, Royal hover, Deep strong)", () => {
  it("keeps the owner's anchors", () => {
    expect([APP_BRAND.primary, APP_BRAND.primaryHover, APP_BRAND.strong]).toEqual(["#0082FF", "#0039F5", "#0020B0"]);
  });

  it("every text pairing meets WCAG AA 4.5:1; Electric is used for non-text accents at >= 3:1", () => {
    expect(contrast("#FFFFFF", APP_BRAND.primary)).toBeLessThan(4.5); // why the primary foreground is ink, not white
    expect(contrast(APP_BRAND.onPrimary, APP_BRAND.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(APP_BRAND.onPrimaryHover, APP_BRAND.primaryHover)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(APP_BRAND.strong, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(APP_BRAND.strong, APP_BRAND.selected)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(APP_BRAND.accent, "#FFFFFF")).toBeGreaterThanOrEqual(3);
  });
});

describe("app wordmark", () => {
  it("has stable, readable, unclipped placement sizes from the asset ratio", () => {
    expect(WORDMARK.src).toBe("/brand/careermonke-wordmark-interim.png");
    expect(fs.existsSync(path.join(ROOT, "public", WORDMARK.src))).toBe(true);
    expect([wordmarkWidth("header"), wordmarkWidth("rail"), wordmarkWidth("drawer"), wordmarkWidth("loading")]).toEqual([166, 166, 183, 265]);
  });
});

describe("landing isolation and onboarding copy", () => {
  it("no landing, public header/footer, root layout or global file references the app brand module, asset or tokens", () => {
    for (const f of ["src/app/page.tsx", "src/components/LandingTopArtifact.tsx", "src/styles/careermonke-landing.css", "src/styles/careermonke-landing-lower.css",
      "src/app/layout.tsx", "src/app/globals.css", "tailwind.config.ts", "src/components/GuideHeader.tsx", "src/components/Footer.tsx", "src/components/BrandIcon.tsx",
      "src/lib/seo/structuredData.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/brand\/AppBrand|careermonke-wordmark|--cm-app-/);
    }
  });

  it("onboarding has no Copilot mention left (text, titles or aria)", () => {
    const dirs = ["src/components/onboarding", "src/app/onboarding"];
    const files = dirs.flatMap((d) => fs.readdirSync(path.join(ROOT, d), { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f) && !f.includes("__tests__")).map((f) => path.join(d, f)));
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) expect(read(f), f).not.toMatch(/copilot/i);
  });
});
