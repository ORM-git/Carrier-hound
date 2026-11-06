import { describe, it, expect } from "vitest";
import { getRootStructuredData, hasNoInventedRatings } from "@/lib/seo/structuredData";

describe("getRootStructuredData", () => {
  it("builds an Organization + WebSite graph on the canonical URL", () => {
    const graph = getRootStructuredData("https://careermonke.com/");
    expect(graph["@context"]).toBe("https://schema.org");
    const [org, site] = graph["@graph"];
    expect(org["@type"]).toBe("Organization");
    expect(org.url).toBe("https://careermonke.com");
    expect(org.logo).toBe("https://careermonke.com/careermonke-logo.png");
    expect(site["@type"]).toBe("WebSite");
    expect(site.publisher["@id"]).toBe(org["@id"]);
  });

  it("contains no invented ratings or counts", () => {
    const graph = getRootStructuredData();
    expect(hasNoInventedRatings(graph)).toBe(true);
    expect(JSON.stringify(graph)).not.toMatch(
      /aggregateRating|ratingValue|reviewCount/i
    );
  });
});
