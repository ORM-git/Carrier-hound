// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import CompanyLogo, { companyInitial } from "../CompanyLogo";

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

const sized = (img: HTMLImageElement, w = 128, h = 128) => {
  vi.spyOn(img, "naturalWidth", "get").mockReturnValue(w);
  vi.spyOn(img, "naturalHeight", "get").mockReturnValue(h);
};
// jsdom has no canvas: give the pixel check a 2D context that returns one uniform colour.
const pixels = (rgba: [number, number, number, number]) => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: () => undefined,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => rgba[i % 4]) }),
  } as any);
};

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
      `${SB}/storage/v1/object/public/company-logos/%E0%A4%A.png`, // malformed escape: initials, no throw
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
    sized(img);
    fireEvent.load(img);
    expect(container.querySelector("img")!.getAttribute("src")).toBe(logo);
    expect(container.querySelector("img")!.className).not.toContain("opacity-0");
    expect(container.textContent).toBe(""); // initials layer removed once the logo is shown
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.className).toContain("bg-slate-50");
    expect(tile.className).toContain("w-10 h-10");
  });

  it("while the logo loads, readable initials are visible in the same box (no blank tile, no layout shift)", () => {
    const { container } = render(<CompanyLogo company="Acme" logoUrl={url()} className="w-10 h-10" />);
    const tile = container.firstElementChild as HTMLElement;
    const loadingClasses = tile.className;
    expect(container.querySelector("img")!.className).toContain("opacity-0");
    expect(container.textContent).toBe("A");
    fireEvent.error(container.querySelector("img")!);
    expect((container.firstElementChild as HTMLElement).className).toBe(loadingClasses); // identical box after failure
    expect(container.textContent).toBe("A");
  });

  it("an image that loads but is transparent / near-invisible on the tile falls back to initials", () => {
    pixels([0, 0, 0, 0]);
    const logo = url();
    const { container } = render(<CompanyLogo company="Acme" logoUrl={logo} />);
    const img = container.querySelector("img")!;
    sized(img);
    fireEvent.load(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });

  it("an image measured readable on the tile is shown", () => {
    pixels([17, 24, 39, 255]);
    const { container } = render(<CompanyLogo company="Acme" logoUrl={url()} />);
    const img = container.querySelector("img")!;
    sized(img);
    fireEvent.load(img);
    expect(container.querySelector("img")!.className).not.toContain("opacity-0");
  });

  it("a failed old URL does not poison the repaired (new content-hashed) URL", () => {
    const oldUrl = url();
    const repaired = url();
    const { container, rerender } = render(<CompanyLogo company="Acme" logoUrl={oldUrl} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    rerender(<CompanyLogo company="Acme" logoUrl={repaired} />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(repaired);
    sized(img);
    fireEvent.load(img);
    expect(container.querySelector("img")!.className).not.toContain("opacity-0");
  });

  it("loads the hosted logo with anonymous CORS so its pixels can be measured", () => {
    const { container } = render(<CompanyLogo company="Acme" logoUrl={url()} />);
    expect(container.querySelector("img")!.getAttribute("crossorigin")).toBe("anonymous");
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

describe("companyInitial", () => {
  it("is deterministic: first letter or digit, upper-cased, '?' when none", () => {
    expect(companyInitial("acme")).toBe("A");
    expect(companyInitial("  (stealth) labs")).toBe("S");
    expect(companyInitial("42crunch")).toBe("4");
    expect(companyInitial("Ébène")).toBe("É");
    expect(companyInitial("")).toBe("?");
    expect(companyInitial(null)).toBe("?");
  });

  it("initials scale with the tile so the 24px detail chip never clips them", () => {
    const { container } = render(<CompanyLogo company="Zeta" logoUrl={null} className="w-6 h-6 p-0.5" />);
    const span = container.querySelector("span")!;
    expect(span.style.fontSize).toBe("min(45cqmin, 1.25rem)");
    expect((span.parentElement as HTMLElement).style.containerType).toBe("size");
  });
});
