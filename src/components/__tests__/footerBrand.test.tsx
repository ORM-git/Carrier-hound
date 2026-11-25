import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/jobs" }));
import Footer from "../Footer";

describe("shared footer brand", () => {
  it("keeps the blue full wordmark and accessible image name without duplicate black brand text", () => {
    const html = renderToStaticMarkup(<Footer />);
    expect(html).toContain('alt="Career Monke"');
    expect(html).toContain("careermonke-logo-v2.png");
    expect(html).not.toMatch(/<span[^>]*>Career Monke<\/span>/);
    for (const label of ["Discovery", "Information", "Contact Us", "Olive Ridley Media Private Limited"]) expect(html).toContain(label);
  });
});
