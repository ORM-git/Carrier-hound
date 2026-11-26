import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OFFICIAL_LOGO_FILES, isOfficialLogoPath, officialLogoFor } from "../officialLogoAssets";
import { safeTickerLogo } from "@/components/landing/LiveLandingTicker";

describe("official ticker logo assets", () => {
  it("every mapped file exists and is a PNG", () => {
    for (const f of Object.values(OFFICIAL_LOGO_FILES)) {
      const buf = fs.readFileSync(path.join(process.cwd(), "public/company-logos-static", f));
      expect(buf.subarray(1, 4).toString()).toBe("PNG");
    }
  });
  it("matches exact normalized names only", () => {
    expect(officialLogoFor("Reddit")).toBe("/company-logos-static/reddit.png");
    expect(officialLogoFor("  Cloudflare, Inc. ")).toBe("/company-logos-static/cloudflare.png");
    expect(officialLogoFor("Microsoft")).toBe("/company-logos-static/microsoft.png");
    expect(officialLogoFor("Microsoft Corporation")).toBe("/company-logos-static/microsoft.png");
    expect(officialLogoFor("Bosch Group")).toBe("/company-logos-static/bosch.png");
    expect(officialLogoFor("Wise")).toBe("/company-logos-static/wise.png");
    expect(officialLogoFor("Reddit Analytics Co")).toBeNull();
    expect(officialLogoFor("Wolt Labs")).toBeNull();
    expect(officialLogoFor("Warp")).toBeNull();
    expect(officialLogoFor(null)).toBeNull();
    for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "prototype", "Constructor"]) {
      expect(officialLogoFor(k)).toBeNull();
    }
  });
  it("client accepts only allowlisted bundled paths besides storage logos", () => {
    expect(safeTickerLogo("/company-logos-static/okta.png")).toBe("/company-logos-static/okta.png");
    expect(isOfficialLogoPath("/company-logos-static/evil.png")).toBe(false);
    expect(safeTickerLogo("/company-logos-static/../x.png")).toBeNull();
    expect(safeTickerLogo("https://evil.example/company-logos/a.png")).toBeNull();
  });
});
