import { readFileSync } from "fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/jobs", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth/session", () => ({ signOutUser: vi.fn() }));

import AppTopBar, { type TopBarTab } from "../AppTopBar";

// CM mobile item 15: compact hamburger + Recommended/Saved/Applied row on the mobile jobs feed only.
const tab = (id: string, label: string, count?: number | string, active = false): TopBarTab => ({ id, label, count, active, onClick: () => {} });
const tabs = [tab("recommended", "Recommended", "1,000", true), tab("saved", "Saved", 3), tab("applied", "Applied", 0)];

describe("mobile jobs feed tab row (item 15)", () => {
  it("renders three flexible min-w-0 tabs with counts, an aria-current selection and the menu button", () => {
    const html = renderToStaticMarkup(<AppTopBar pageLabel="JOBS" tabs={[...tabs, tab("external", "External", 25)]} mobileTabs={tabs} onSearchChange={() => {}} />);
    const nav = html.slice(html.indexOf('data-testid="mobile-feed-tabs"'), html.indexOf("</nav>"));
    expect(nav.match(/<button/g)).toHaveLength(3);
    expect(nav).not.toContain("External");
    expect(nav.match(/relative flex-1 min-w-0/g)).toHaveLength(3);
    for (const c of ["1,000", ">3<", ">0<"]) expect(nav).toContain(c);
    expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Open navigation menu"');
    // Search toggle and account controls exist but are hidden below sm; desktop tabs keep External.
    expect(html).toMatch(/class="hidden sm:flex items-center gap-2 sm:gap-2.5 shrink-0"/);
    expect(html.slice(html.indexOf("</nav>"))).toContain("External");
  });

  it("other pages (no mobileTabs) keep their mobile header", () => {
    const html = renderToStaticMarkup(<AppTopBar pageLabel="TRACKER" onSearchChange={() => {}} />);
    expect(html).not.toContain("mobile-feed-tabs");
    expect(html).not.toContain("hidden sm:flex items-center");
    expect(html).not.toContain("sr-only sm:not-sr-only");
  });

  it("jobs page: only the list view passes mobile tabs without External; the old mobile pill row and search input are gone", () => {
    const page = readFileSync("src/app/jobs/page.tsx", "utf8");
    expect(page).toContain('mobileTabs={isListView ? jobTabs.filter((tab) => tab.id !== "external") : undefined}');
    expect(page).not.toContain("Mobile search bar (<640px)");
    expect(page).not.toContain("Mobile tabs (<640px)");
  });
});
