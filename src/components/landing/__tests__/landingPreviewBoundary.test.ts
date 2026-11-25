import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("src/app/page.tsx", "utf8");

describe("landing preview bundle boundary", () => {
  it("code-splits the unchanged shared preview while retaining default server rendering", () => {
    expect(page).toContain('import dynamic from "next/dynamic"');
    expect(page).toContain('const LandingJobsPreview = dynamic(() => import("@/components/landing/LandingJobsPreview"));');
    expect(page).not.toContain('import LandingJobsPreview from "@/components/landing/LandingJobsPreview"');
    expect(page).not.toMatch(/ssr\s*:\s*false/);
    expect(page).toContain("<LandingJobsPreview />");
  });
});
