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
    expect(detail.match(/<CompanyLogo\b[^>]*locked=\{!isUnlocked\}/g)).toHaveLength(6);
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


describe("approved job-list palette", () => {
  const gradients = [
    "linear-gradient(160deg,#8ec5fc,#4a7de0)", "linear-gradient(160deg,#f6d365,#e0653a)",
    "linear-gradient(160deg,#a8e063,#3f9d4f)", "linear-gradient(160deg,#fbc2eb,#a64ac9)",
    "linear-gradient(160deg,#89f7fe,#3a8fd9)", "linear-gradient(160deg,#fda085,#d4456f)",
    "linear-gradient(160deg,#cfd9ff,#5d6ee0)", "linear-gradient(160deg,#ffe29f,#e08a2e)",
  ];
  it("uses all eight exact preview angles/stops without identity in locked DOM", () => {
    const rendered = Array.from({length:8},(_,i)=>renderToStaticMarkup(<CompanyLogo company="Secret Employer" domain="secret.example" logoUrl="https://secret.example/logo.png" locked maskSeed={String.fromCharCode(104+i)} maskedPalette="job-list-preview" />));
    for(const gradient of gradients) expect(rendered.some(html=>html.includes(gradient))).toBe(true);
    for(const html of rendered) { expect(html).not.toMatch(/Secret|secret|<img|<svg|<span/); }
    expect(rendered[0]).toBe(renderToStaticMarkup(<CompanyLogo company="Another Employer" locked maskSeed="h" maskedPalette="job-list-preview" />));
  });
  it("keeps unlocked logos and non-list default tiles unchanged", () => {
    const props={company:"Acme", logoUrl:"https://cdn.example/logo.png"};
    expect(renderToStaticMarkup(<CompanyLogo {...props} maskedPalette="job-list-preview" />)).toBe(renderToStaticMarkup(<CompanyLogo {...props} />));
    expect(renderToStaticMarkup(<CompanyLogo {...props} locked />)).not.toContain("background-image");
  });
  it("opts in phone job-list cards only, preserving desktop", () => {
    const source=readFileSync("src/components/jobs/JobCardContent.tsx","utf8");
    expect(source.match(/maskedPalette="job-list-preview"/g)).toHaveLength(1);
    const desktop=source.slice(source.indexOf("DESKTOP VIEW"),source.indexOf("MOBILE VIEW"));
    expect(desktop).not.toContain('maskedPalette="job-list-preview"');
  });
});
