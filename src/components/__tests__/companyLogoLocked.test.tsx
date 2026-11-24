import { readFileSync } from "fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CompanyLogo from "../CompanyLogo";

// CM mobile item 14: locked (free/guest) jobs get a silhouette with no protected identity in the DOM.
describe("CompanyLogo locked silhouette (item 14)", () => {
  const props = { company: "Acme Rockets", logoUrl: "https://cdn.example/acme.png", domain: "acme.com", applyUrl: "https://acme.com/jobs/1" };

  it("locked: no name, initial, alt, logo URL or domain lookup in the markup", () => {
    const html = renderToStaticMarkup(<CompanyLogo {...props} locked />);
    expect(html).toContain('data-testid="company-logo-locked"');
    expect(html).not.toMatch(/<img/);
    for (const leak of ["Acme", ">A<", "acme.com", "cdn.example", "unavatar"]) expect(html).not.toContain(leak);
  });

  it("unlocked: the genuine logo is shown", () => {
    const html = renderToStaticMarkup(<CompanyLogo {...props} />);
    expect(html).toContain('src="https://cdn.example/acme.png"');
    expect(html).toContain('alt="Acme Rockets logo"');
  });

  it("every job card/detail logo passes the lock, and locked company text is a placeholder, not CSS-blurred", () => {
    const page = readFileSync("src/app/jobs/page.tsx", "utf8");
    const detail = readFileSync("src/components/jobs/JobDetailView.tsx", "utf8");
    expect(page.match(/<CompanyLogo\s+company=\{job\.company\}\s+locked=\{!isPro\}/g)).toHaveLength(2);
    // 5 detail logos + the card menu (share text / report email omit the employer when locked).
    expect(detail.match(/locked=\{!isUnlocked\}/g)).toHaveLength(6);
    expect(detail).toMatch(/<JobCardMenu[^>]*locked=\{!isUnlocked\}/);
    expect(page.match(/<JobCardMenu\s+job=\{job\}\s+locked=\{!isPro\}/g)).toHaveLength(2);
    expect(page).not.toContain('{job.company || "Verified Employer"}');
    expect(detail).not.toMatch(/\{(job|simJob)\.company \|\| "Verified Employer"\}/);
  });
});
