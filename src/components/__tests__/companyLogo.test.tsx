// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import CompanyLogo from "../CompanyLogo";

// jsdom never loads images and reports every <img> as complete with naturalWidth 0. Model a real browser:
// a freshly mounted image is still loading (complete = false) unless a test says otherwise.
beforeEach(() => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Failures are remembered per URL for the page session, so every test uses its own URLs.
let n = 0;
const url = () => `https://broken.invalid/logo-${++n}.png`;
const dom = () => `acme${++n}.com`;

describe("CompanyLogo", () => {
  it("broken stored logo with no domain falls back to the letter tile (onError)", () => {
    const logo = url();
    const { container } = render(<CompanyLogo company="Acme" logoUrl={logo} />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(logo);
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });

  it("broken stored logo tries the company domain, then the letter tile", () => {
    const d = dom();
    const { container } = render(<CompanyLogo company="Acme" logoUrl={url()} domain={`www.${d}`} />);
    fireEvent.error(container.querySelector("img")!);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(`https://unavatar.io/${d}?fallback=false`);
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });

  it("image already complete with naturalWidth 0 on mount (CSP / cached failure, no error event) -> tile", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(0);
    const { container } = render(<CompanyLogo company="Acme" logoUrl={url()} domain={dom()} />);
    // both candidates are rejected on mount without any event firing
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

  it("a successful load keeps the image", () => {
    const logo = url();
    const { container } = render(<CompanyLogo company="Acme" logoUrl={logo} />);
    const img = container.querySelector("img")!;
    vi.spyOn(img, "naturalWidth", "get").mockReturnValue(128);
    fireEvent.load(img);
    expect(container.querySelector("img")!.getAttribute("src")).toBe(logo);
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

  it("stored domain wins over the apply URL, and ATS domains are ignored", () => {
    const d = dom();
    const { container, rerender } = render(
      <CompanyLogo company="Acme" domain={d} applyUrl="https://other.com/job" />
    );
    expect(container.querySelector("img")!.getAttribute("src")).toContain(`unavatar.io/${d}`);

    rerender(<CompanyLogo company="Acme" domain="boards.greenhouse.io" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });
});
