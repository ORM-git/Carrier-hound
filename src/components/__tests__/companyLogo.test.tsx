// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import CompanyLogo from "../CompanyLogo";

const SB = "https://proj.supabase.co";
beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SB;
});

// jsdom never loads images and reports every image element as complete with naturalWidth 0. Model a real browser:
// a freshly mounted image is still loading (complete = false) unless a test says otherwise.
beforeEach(() => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Failures are remembered per URL for the page session, so every test uses its own eligible hosted URL.
let n = 0;
const url = () => `${SB}/storage/v1/object/public/company-logos/00000000-0000-4000-8000-${String(++n).padStart(12, "0")}.png`;

describe("CompanyLogo", () => {
  it("broken hosted logo falls back to the letter tile (onError)", () => {
    const logo = url();
    const { container } = render(<CompanyLogo company="Acme" logoUrl={logo} />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(logo);
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });

  it("never renders an external, ATS, favicon-service or other-bucket URL: initials instead", () => {
    for (const bad of [
      "https://www.google.com/s2/favicons?domain=acme.com&sz=128",
      "https://unavatar.io/acme.com?fallback=false",
      "https://s2-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/1/acme.png",
      `${SB}/storage/v1/object/public/avatars/00000000-0000-4000-8000-000000000001.png`,
      "https://evil.supabase.co/storage/v1/object/public/company-logos/00000000-0000-4000-8000-000000000001.png",
    ]) {
      const { container, unmount } = render(<CompanyLogo company="Acme" logoUrl={bad} />);
      expect(container.querySelector("img")).toBeNull();
      expect(container.textContent).toBe("A");
      unmount();
    }
  });

  it("a domain or apply URL alone never produces a third-party image", () => {
    const { container } = render(<CompanyLogo company="Acme" domain="acme.com" applyUrl="https://acme.com/jobs/1" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });

  it("image already complete with naturalWidth 0 on mount (CSP / cached failure, no error event) -> tile", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(0);
    const { container } = render(<CompanyLogo company="Acme" logoUrl={url()} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });

  it("load event with naturalWidth 0 -> tile", () => {
    const { container } = render(<CompanyLogo company="Acme" logoUrl={url()} />);
    const img = container.querySelector("img")!;
    vi.spyOn(img, "naturalWidth", "get").mockReturnValue(0);
    fireEvent.load(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });

  it("a successful load keeps the image on a neutral light backing (dark transparent marks stay visible)", () => {
    const logo = url();
    const { container } = render(<CompanyLogo company="Acme" logoUrl={logo} className="w-10 h-10" />);
    const img = container.querySelector("img")!;
    vi.spyOn(img, "naturalWidth", "get").mockReturnValue(128);
    fireEvent.load(img);
    expect(container.querySelector("img")!.getAttribute("src")).toBe(logo);
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.className).toContain("bg-slate-50");
    expect(tile.className).toContain("w-10 h-10");
  });

  it("once failed, stays on the tile across remounts and unrelated prop changes", () => {
    const logo = url();
    const first = render(<CompanyLogo company="Acme" logoUrl={logo} />);
    fireEvent.error(first.container.querySelector("img")!);
    first.rerender(<CompanyLogo company="Acme Inc" logoUrl={logo} className="w-8 h-8" />);
    expect(first.container.querySelector("img")).toBeNull();
    first.unmount();
    const again = render(<CompanyLogo company="Acme" logoUrl={logo} />);
    expect(again.container.querySelector("img")).toBeNull();
    expect(again.container.textContent).toBe("A");
  });

  it("two mounted instances sharing a failing URL both fall back once each errors", () => {
    const logo = url();
    const { container } = render(
      <>
        <CompanyLogo company="Acme" logoUrl={logo} />
        <CompanyLogo company="Acme" logoUrl={logo} />
      </>
    );
    const imgs = container.querySelectorAll("img");
    expect(imgs.length).toBe(2);
    fireEvent.error(imgs[0]);
    fireEvent.error(imgs[1]);
    expect(container.querySelectorAll("img").length).toBe(0);
    expect(container.textContent).toBe("AA");
  });

  it("the initials tile keeps the same size class as the logo tile", () => {
    const { container } = render(<CompanyLogo company="Zeta" logoUrl={null} className="w-8 h-8" />);
    expect((container.firstElementChild as HTMLElement).className).toContain("w-8 h-8");
    expect(container.textContent).toBe("Z");
  });
});
