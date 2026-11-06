// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { JsonLd } from "./JsonLd";

describe("JsonLd", () => {
  it("renders an application/ld+json script with the provided data", () => {
    const data = { "@context": "https://schema.org", "@type": "Thing", name: "Test" };
    const { container } = render(<JsonLd data={data} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    expect(JSON.parse(script!.textContent || "")).toEqual(data);
  });

  it("escapes '<' as \\u003c so markup cannot break out of the script tag", () => {
    const data = { "@type": "Thing", name: "</script><script>alert(1)</script>" };
    const { container } = render(<JsonLd data={data} />);
    const script = container.querySelector("script")!;
    expect(script.textContent).not.toContain("</script>");
    expect(script.textContent).toContain("\\u003c/script>");
  });

  it("falls back to the root Organization/WebSite graph without data", () => {
    const { container } = render(<JsonLd />);
    const script = container.querySelector("script")!;
    const parsed = JSON.parse(script.textContent || "");
    const types = JSON.stringify(parsed);
    expect(types).toContain("Organization");
  });
});
