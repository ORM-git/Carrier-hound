// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { BreadcrumbJsonLd } from "./BreadcrumbJsonLd";

describe("BreadcrumbJsonLd", () => {
  const trail = [
    { name: "Home", path: "/" },
    { name: "Pricing", path: "/pricing" },
  ];

  it("renders a BreadcrumbList with ordered ListItem entries", () => {
    const { container } = render(<BreadcrumbJsonLd trail={trail} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const parsed = JSON.parse(script!.innerHTML);
    expect(parsed["@type"]).toBe("BreadcrumbList");
    expect(parsed.itemListElement).toHaveLength(2);
    expect(parsed.itemListElement[0]).toMatchObject({
      "@type": "ListItem",
      position: 1,
      name: "Home",
    });
    expect(parsed.itemListElement[1].position).toBe(2);
    expect(parsed.itemListElement[1].item).toMatch(/\/pricing$/);
  });

  it("has no visual output (script tag only)", () => {
    const { container } = render(<BreadcrumbJsonLd trail={trail} />);
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild!.tagName).toBe("SCRIPT");
  });
});
