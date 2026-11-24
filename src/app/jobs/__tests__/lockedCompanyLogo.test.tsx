// @vitest-environment jsdom
// CM mobile item 14: locked (guest/free) jobs leak no employer identity through the logo, card or detail.
// FIXTURE identity only: every protected string below is invented and unique so any leak is detectable.
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import CompanyLogo from "@/components/CompanyLogo";
import { fixtureJob, flush, h, installBrowserStandIns, page, resetHarness } from "./jobsHarness";

vi.mock("@/lib/jobs/service", async () => (await import("./jobsHarness")).jobsServiceMock());
vi.mock("@/lib/auth/session", async () => (await import("./jobsHarness")).sessionMock());
vi.mock("@/lib/billing/subscription", async () => (await import("./jobsHarness")).billingMock());
vi.mock("@/lib/tracker/storage", async () => (await import("./jobsHarness")).trackerMock());
vi.mock("@/lib/resume/storage", async () => (await import("./jobsHarness")).resumeStorageMock());
vi.mock("next/navigation", async () => (await import("./jobsHarness")).navigationMock());
vi.mock("@/lib/analytics/funnel", async () => (await import("./jobsHarness")).funnelMock());
vi.mock("@/lib/supabase/client", async () => (await import("./jobsHarness")).supabaseClientMock());
vi.mock("react-toastify", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import JobsPage from "@/app/jobs/page";

const NAME = "Qwyzzlenex Orbital";
const DOMAIN = "qwyzzlenex-orbital.invalid";
const LOGO = `https://cdn.${DOMAIN}/brand/logo.png`;
const APPLY = `https://careers.${DOMAIN}/jobs/123`;
const PROTECTED = [/qwyzzlenex/i, /orbital/i, new RegExp(DOMAIN.replace(/\./g, "\\."), "i"), /unavatar/i];

function leaks(text: string) {
  return PROTECTED.filter((re) => re.test(text)).map(String);
}

/** Every attribute value and text node in a subtree, including alt/title/style/src/aria-*. */
function everything(root: Element) {
  const parts: string[] = [root.textContent || ""];
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const a of Array.from(el.attributes)) parts.push(`${a.name}=${a.value}`);
  }
  return parts.join("\n");
}

/** Accessible names of everything exposed to assistive tech (aria-hidden subtrees skipped). */
function accessibleText(root: Element) {
  const out: string[] = [];
  const walk = (el: Element) => {
    if (el.getAttribute("aria-hidden") === "true") return;
    for (const a of ["aria-label", "alt", "title"]) {
      const v = el.getAttribute(a);
      if (v) out.push(v);
    }
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) out.push(n.textContent || "");
      else if (n.nodeType === 1) walk(n as Element);
    }
  };
  walk(root);
  return out.join(" ");
}

let imgSrcRequests: string[] = [];
beforeAll(() => {
  installBrowserStandIns();
  // Record every image URL the page asks the browser to fetch (jsdom does not fetch, so we watch src).
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    ...desc,
    set(v: string) {
      imgSrcRequests.push(String(v));
      desc.set!.call(this, v);
    },
  });
  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name: string, value: string) {
    if (this instanceof HTMLImageElement && (name === "src" || name === "srcset")) imgSrcRequests.push(String(value));
    return setAttr.call(this, name, value);
  };
});
beforeEach(() => {
  resetHarness();
  imgSrcRequests = [];
  localStorage.clear();
});
afterEach(() => cleanup());

describe("CompanyLogo locked silhouette (unit)", () => {
  const cases = [
    { label: "logo URL + domain", props: { logoUrl: LOGO, domain: DOMAIN, applyUrl: APPLY } },
    { label: "no logo, domain only", props: { domain: DOMAIN, applyUrl: APPLY } },
    { label: "no logo, no domain", props: {} },
  ];
  it.each(cases)("locked ($label): constant silhouette, no identity in DOM, a11y tree or image fetch", ({ props }) => {
    const { container } = render(<CompanyLogo company={NAME} locked {...props} className="w-8 h-8" />);
    const el = screen.getByTestId("company-logo-locked");
    expect(leaks(everything(container))).toEqual([]);
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.textContent).toBe("");
    expect(container.querySelector("img")).toBeNull();
    expect(imgSrcRequests).toEqual([]);
    // Constant markup: identical whatever the company.
    const other = render(<CompanyLogo company="Another Fixture Co" locked className="w-8 h-8" />);
    expect(other.container.innerHTML).toBe(container.innerHTML);
  });

  it("Pro: genuine logo first, then a neutral letter tile after the image errors", () => {
    // Own URL: CompanyLogo remembers failed URLs for the page lifetime.
    const ERR_LOGO = `https://cdn.${DOMAIN}/brand/broken.png`;
    const { container } = render(<CompanyLogo company={NAME} logoUrl={ERR_LOGO} className="w-8 h-8" />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(ERR_LOGO);
    expect(img.getAttribute("alt")).toBe(`${NAME} logo`);
    fireEvent.error(img);
    // No domain: straight to the letter tile, no broken image left behind.
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("Q");
  });

  it("Pro with no logo and no domain: letter tile, no image request", () => {
    const { container } = render(<CompanyLogo company="Plainfixture Ltd" className="w-8 h-8" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("P");
    expect(imgSrcRequests).toEqual([]);
  });
});

const lockedJob = (i: number) =>
  fixtureJob(i, { company: NAME, companyDomain: DOMAIN, logoUrl: LOGO, logo_url: LOGO, applyUrl: APPLY, title: `Fixture Locked Role ${i}` });

async function mountFeed() {
  window.history.replaceState(null, "", "/jobs");
  render(<JobsPage />);
  await flush();
}

describe("report-issue email", () => {
  it("omits the employer when locked and keeps it when unlocked", async () => {
    const { getReportJobMailto } = await import("@/components/jobs/JobDetailView");
    const job = { id: "fx-9", title: "Fixture Role", company: NAME };
    expect(leaks(decodeURIComponent(getReportJobMailto(job, true)))).toEqual([]);
    expect(decodeURIComponent(getReportJobMailto(job, true))).toContain("Job ID: fx-9");
    expect(decodeURIComponent(getReportJobMailto(job))).toContain(`Company: ${NAME}`);
  });
});

describe("integrated jobs masking: guest and free (locked) vs Pro", () => {
  it.each([
    { who: "guest", user: null },
    { who: "free", user: { id: "fx-free", email: "free@example.invalid" } },
  ])("$who: feed cards and the opened detail never expose the protected employer", async ({ user }) => {
    h.user = user;
    h.isPro = false;
    h.transport = async () => page([lockedJob(1), lockedJob(2), fixtureJob(3, { company: NAME, logoUrl: null, companyDomain: null, applyUrl: APPLY })], false, 3);
    h.byId = async (id) => lockedJob(Number(id.replace("fx-", "")));
    await mountFeed();
    expect(screen.getAllByText("Fixture Locked Role 1").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("company-logo-locked").length).toBeGreaterThanOrEqual(3);

    const body = document.body;
    expect(leaks(everything(body))).toEqual([]);
    expect(leaks(accessibleText(body))).toEqual([]);
    expect(imgSrcRequests.filter((u) => leaks(u).length)).toEqual([]);

    // Open the detail of a locked job: still nothing.
    fireEvent.click(screen.getAllByText("Fixture Locked Role 1")[0]);
    await flush();
    expect(leaks(everything(body))).toEqual([]);
    expect(leaks(accessibleText(body))).toEqual([]);
    expect(imgSrcRequests.filter((u) => leaks(u).length)).toEqual([]);

    // Card menu actions that leave the page (share sheet, report email) do not carry the employer either.
    const shared: any[] = [];
    Object.defineProperty(navigator, "share", { configurable: true, value: async (d: any) => void shared.push(d) });
    fireEvent.click(screen.getAllByTestId("job-card-menu-button")[0]);
    await act(async () => fireEvent.click(screen.getByTestId("job-card-menu-item-share")));
    expect(shared).toHaveLength(1);
    expect(leaks(JSON.stringify(shared))).toEqual([]);
    delete (navigator as any).share;
  });

  it("Pro: the genuine logo and name render on the card", async () => {
    h.user = { id: "fx-pro", email: "pro@example.invalid" };
    h.isPro = true;
    h.transport = async () => page([lockedJob(1)], false, 1);
    await mountFeed();
    expect(screen.queryAllByTestId("company-logo-locked")).toHaveLength(0);
    const imgs = Array.from(document.querySelectorAll("img")).filter((i) => i.getAttribute("src") === LOGO);
    expect(imgs.length).toBeGreaterThan(0);
    expect(imgs[0].getAttribute("alt")).toBe(`${NAME} logo`);
    expect(screen.getAllByText(NAME).length).toBeGreaterThan(0);
    // An image error falls back to a neutral letter tile (no broken image).
    await act(async () => imgs.forEach((i) => fireEvent.error(i)));
    expect(Array.from(document.querySelectorAll("img")).filter((i) => i.getAttribute("src") === LOGO)).toHaveLength(0);
  });
});
