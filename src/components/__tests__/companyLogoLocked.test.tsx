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
    const card = readFileSync("src/components/jobs/JobCardContent.tsx", "utf8");
    expect(page).toMatch(/<JobCardContent\b[\s\S]*?isPro=\{isPro\}/);
    const detail = readFileSync("src/components/jobs/JobDetailView.tsx", "utf8");
    expect(card.match(/<CompanyLogo\s+company=\{job\.company\}\s+locked=\{!isPro\}/g)).toHaveLength(2);
    expect(detail.match(/<CompanyLogo\b[^>]*locked=\{!isUnlocked\}/g)).toHaveLength(5);
    expect(detail).toMatch(/<JobCardMenu\b[^>]*locked=\{!isUnlocked\}/);
    expect(card).not.toContain('{job.company || "Verified Employer"}');
    expect(detail).not.toMatch(/\{(job|simJob)\.company \|\| "Verified Employer"\}/);
  });
});

// Gradient-only masked tile (user-approved): no icon, palette from constants, pick from the opaque job id only.
describe("CompanyLogo masked gradient tile", () => {
  const base = { company: "Acme Rockets", logoUrl: "https://cdn.example/acme.png", domain: "acme.com" };
  it("renders a gradient tile with no svg icon, text or image", () => {
    const html = renderToStaticMarkup(<CompanyLogo {...base} locked maskSeed="job-1" />);
    expect(html).toContain("bg-gradient-to-br");
    expect(html).not.toMatch(/<svg|<img|<span/);
    for (const leak of ["Acme", "acme.com", "cdn.example"]) expect(html).not.toContain(leak);
  });
  it("colour depends on the job id, never on the company", () => {
    const a = renderToStaticMarkup(<CompanyLogo {...base} locked maskSeed="job-1" />);
    const b = renderToStaticMarkup(<CompanyLogo {...base} company="Zeta Corp" domain="zeta.io" locked maskSeed="job-1" />);
    expect(a).toBe(b);
    const picks = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => renderToStaticMarkup(<CompanyLogo {...base} locked maskSeed={id} />)));
    expect(picks.size).toBeGreaterThan(2);
  });
  it("no seed gives one fixed tile; unlocked chain is unchanged", () => {
    expect(renderToStaticMarkup(<CompanyLogo {...base} locked />)).toBe(renderToStaticMarkup(<CompanyLogo company="Other" locked />));
    expect(renderToStaticMarkup(<CompanyLogo {...base} />)).toContain('alt="Acme Rockets logo"');
  });
});
