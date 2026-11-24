import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { jobDescriptionText } from "../descriptionText";

describe("job description display text", () => {
  it.each(["&nbsp;", "&amp;nbsp;", "&amp;amp;nbsp;", "&#160;", "&#xA0;"])("removes escaped whitespace %s before a heading", (prefix) => {
    expect(jobDescriptionText(`${prefix}About Gusto`)).toBe("About Gusto");
  });
  it("decodes common punctuation without changing line breaks or unknown entities", () => {
    expect(jobDescriptionText("R&amp;D\n&ldquo;Teams&rdquo; &#x1F680; &unknown;")).toBe("R&D\n\u201cTeams\u201d \ud83d\ude80 &unknown;");
  });
  it("strips executable markup after decoding, including nested escaped scripts", () => {
    expect(jobDescriptionText("&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;About &lt;b&gt;Gusto&lt;/b&gt;")).toBe("About Gusto");
    expect(jobDescriptionText('&lt;img src=x onerror=alert(1)&gt;Safe')).toBe("Safe");
  });
  it("returns inert React text, never active HTML", () => {
    const html = renderToStaticMarkup(<div>{jobDescriptionText("&lt;script&gt;alert(1)&lt;/script&gt;R&amp;D &lt; 5")}</div>);
    expect(html).toBe("<div>R&amp;D &lt; 5</div>");
    expect(html).not.toContain("<script");
  });
  it("handles missing and invalid numeric entities without throwing", () => {
    expect(jobDescriptionText(null)).toBe("");
    expect(jobDescriptionText("&#9999999999; &#xD800;")).toBe("\ufffd \ufffd");
  });
});
