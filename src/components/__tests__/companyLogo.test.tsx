// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import CompanyLogo from "../CompanyLogo";

afterEach(cleanup);

describe("CompanyLogo", () => {
  it("broken stored logo with no domain falls back to the letter tile", () => {
    const { container } = render(
      <CompanyLogo company="Acme" logoUrl="https://broken.invalid/logo.png" />
    );
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://broken.invalid/logo.png");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });

  it("broken stored logo tries the company domain, then the letter tile", () => {
    const { container } = render(
      <CompanyLogo company="Acme" logoUrl="https://broken.invalid/logo.png" domain="www.acme.com" />
    );
    fireEvent.error(container.querySelector("img")!);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://unavatar.io/acme.com?fallback=false");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });

  it("stored domain wins over the apply URL, and ATS domains are ignored", () => {
    const { container, rerender } = render(
      <CompanyLogo company="Acme" domain="acme.com" applyUrl="https://other.com/job" />
    );
    expect(container.querySelector("img")!.getAttribute("src")).toContain("unavatar.io/acme.com");

    rerender(<CompanyLogo company="Acme" domain="boards.greenhouse.io" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });
});
