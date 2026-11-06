import { getSiteUrl } from "@/lib/siteUrl";

export interface OrganizationJsonLd {
  "@type": "Organization";
  "@id": string;
  name: string;
  url: string;
  logo: string;
}

export interface SearchActionTarget {
  "@type": "EntryPoint";
  urlTemplate: string;
}

export interface WebSiteJsonLd {
  "@type": "WebSite";
  "@id": string;
  name: string;
  url: string;
  publisher: {
    "@id": string;
  };
  potentialAction: {
    "@type": "SearchAction";
    target: SearchActionTarget;
    "query-input": string;
  };
}

export interface RootJsonLdGraph {
  "@context": "https://schema.org";
  "@graph": [OrganizationJsonLd, WebSiteJsonLd];
}

/**
 * Returns canonical, privacy-preserving, verified JSON-LD structured data
 * for the root layout head: Organization and WebSite with SearchAction.
 * Strictly uses only values already on the site:
 * - name: "CareerMonke"
 * - url: canonical base URL from getSiteUrl() ("https://careermonke.com")
 * - logo path: "/careermonke-logo.png" (official full brand logo)
 * Zero invented ratings, zero aggregateRating, zero invented counts.
 */
export function getRootStructuredData(overrideUrl?: string): RootJsonLdGraph {
  const baseUrl = (overrideUrl || getSiteUrl()).trim().replace(/\/+$/, "");
  const orgId = `${baseUrl}/#organization`;
  const websiteId = `${baseUrl}/#website`;

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": orgId,
        name: "CareerMonke",
        url: baseUrl,
        logo: `${baseUrl}/careermonke-logo.png`,
      },
      {
        "@type": "WebSite",
        "@id": websiteId,
        name: "CareerMonke",
        url: baseUrl,
        publisher: {
          "@id": orgId,
        },
        potentialAction: {
          "@type": "SearchAction",
          target: {
            "@type": "EntryPoint",
            urlTemplate: `${baseUrl}/jobs?q={search_term_string}`,
          },
          "query-input": "required name=search_term_string",
        },
      },
    ],
  };
}

/**
 * Validates that an arbitrary JSON-LD object contains NO invented aggregateRating
 * or fake reviews/counts, ensuring strict compliance with search engine guidelines.
 */
export function hasNoInventedRatings(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return true;
  const jsonString = JSON.stringify(obj);
  const forbiddenPatterns = [
    /"aggregateRating"/i,
    /"ratingValue"/i,
    /"reviewCount"/i,
    /"ratingCount"/i,
    /"bestRating"/i,
    /"worstRating"/i,
  ];
  return !forbiddenPatterns.some((pattern) => pattern.test(jsonString));
}

/**
 * Resolves the minimal set of external origins the application actually contacts
 * on initial page load:
 * 1. Supabase project URL from environment (`NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL`).
 * 2. Google Fonts: Not contacted at runtime (Next.js `next/font/google` self-hosts locally at build time).
 * 3. Analytics: Not external (uses first-party relative endpoint `/api/track`).
 * Strictly no other origins.
 */
export function getConnectionHints(envUrl?: string): string[] {
  const origins: string[] = [];
  const rawUrl =
    envUrl ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL;

  if (rawUrl && typeof rawUrl === "string" && rawUrl.trim()) {
    try {
      const parsed = new URL(rawUrl.trim());
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        const origin = parsed.origin;
        if (!origins.includes(origin)) {
          origins.push(origin);
        }
      }
    } catch {
      // Invalid URL ignored safely
    }
  }

  return origins;
}

export interface BreadcrumbListItem {
  "@type": "ListItem";
  position: number;
  name: string;
  item: string;
}

export interface BreadcrumbListJsonLd {
  "@context": "https://schema.org";
  "@type": "BreadcrumbList";
  itemListElement: BreadcrumbListItem[];
}

/**
 * Builds BreadcrumbList JSON-LD from an ordered trail of { name, path }.
 * Paths are resolved against the canonical site URL; pass them exactly as
 * they appear in the sitemap (leading slash, no trailing slash).
 */
export function getBreadcrumbJsonLd(
  trail: { name: string; path: string }[],
  overrideUrl?: string
): BreadcrumbListJsonLd {
  const baseUrl = (overrideUrl || getSiteUrl()).trim().replace(/\/+$/, "");
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((crumb, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: crumb.name,
      item: `${baseUrl}${crumb.path}`,
    })),
  };
}
