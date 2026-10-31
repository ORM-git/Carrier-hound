/**
 * Unified Category Taxonomy for CareerMonke
 * Single source of truth for Category Pills, Specific Categories, Ingestion & API.
 */

export interface CanonicalCategory {
  slug: string;
  name: string;
  aliases: string[];
}

export const CANONICAL_CATEGORIES: CanonicalCategory[] = [
  {
    slug: "software",
    name: "Software Development",
    aliases: ["engineering", "technology", "architecture", "dev", "developer"],
  },
  {
    slug: "devops",
    name: "DevOps & Cloud",
    aliases: ["devops-cloud", "infrastructure", "sre", "cloud", "platform"],
  },
  {
    slug: "ai-ml",
    name: "AI & Machine Learning",
    aliases: ["ai", "ml", "artificial-intelligence", "deep-learning", "nlp", "ai-machine-learning", "machine-learning"],
  },
  {
    slug: "data-analytics",
    name: "Data & Analytics",
    aliases: ["data", "data-science", "analytics", "business-intelligence", "bi"],
  },
  {
    slug: "product",
    name: "Product Management",
    aliases: ["product-mgmt", "pm", "product-manager"],
  },
  {
    slug: "design",
    name: "Product & UI/UX Design",
    aliases: ["art-design", "ui", "ux", "graphic-design"],
  },
  {
    slug: "marketing",
    name: "Marketing & Growth",
    aliases: ["product-marketing", "growth", "growth-marketing", "seo", "content-marketing"],
  },
  {
    slug: "sales",
    name: "Sales & Account Exec",
    aliases: ["business-dev", "bd", "account-executive", "partnerships"],
  },
  {
    slug: "finance",
    name: "Finance & Accounting",
    aliases: ["accounting", "fintech", "payroll"],
  },
  {
    slug: "hr",
    name: "HR & People Ops",
    aliases: ["hr-talent", "recruiting", "talent", "people"],
  },
  {
    slug: "operations",
    name: "Business Operations",
    aliases: ["bizops", "ops"],
  },
  {
    slug: "cyber-security",
    name: "Cyber Security & InfoSec",
    aliases: ["security", "infosec", "appsec"],
  },
  {
    slug: "mobile-dev",
    name: "Mobile Development (iOS/Android)",
    aliases: ["ios", "android", "mobile", "flutter", "react-native"],
  },
  {
    slug: "qa-testing",
    name: "Quality Assurance & QA",
    aliases: ["qa", "testing", "sdeta", "quality"],
  },
  {
    slug: "customer-support",
    name: "Customer Support & Success",
    aliases: ["customer-success", "support", "cx"],
  },
  {
    slug: "legal",
    name: "Legal & Compliance",
    aliases: ["compliance", "regulatory"],
  },
  {
    slug: "healthcare",
    name: "Healthcare & Biotech",
    aliases: ["health", "biotech", "medical"],
  },
  {
    slug: "writing",
    name: "Writing & Content Creation",
    aliases: ["writing-content", "copywriting", "technical-writing"],
  },
];

/** Quick pill mappings resolving to canonical slugs */
export const PILL_TO_CANONICAL: Record<string, string[]> = {
  tech: ["software", "devops", "ai-ml", "mobile-dev"],
  ai: ["ai-ml"],
  "ai-ml": ["ai-ml"],
  "ai-machine-learning": ["ai-ml"],
  design: ["design"],
  marketing: ["marketing"],
  finance: ["finance"],
  data: ["data-analytics"],
  product: ["product"],
  hr: ["hr"],
  operations: ["operations"],
  sales: ["sales"],
  "cyber-security": ["cyber-security"],
  "qa-testing": ["qa-testing"],
  "customer-support": ["customer-support"],
  legal: ["legal"],
  healthcare: ["healthcare"],
  writing: ["writing"],
};

/** Normalize any incoming slug/synonym to canonical slug */
export function normalizeCategorySlug(rawSlug: string): string {
  const clean = rawSlug.trim().toLowerCase();
  for (const cat of CANONICAL_CATEGORIES) {
    if (cat.slug === clean || cat.aliases.includes(clean)) {
      return cat.slug;
    }
  }
  return clean;
}

/** Expand an array of category slugs (handling aliases and pill groupings) to all matching DB slugs */
export function expandCategoryFilter(slugs: string[]): string[] {
  const expanded = new Set<string>();

  for (const slug of slugs) {
    const clean = slug.trim().toLowerCase();

    // Check if it's a pill key (e.g. 'tech')
    if (PILL_TO_CANONICAL[clean]) {
      PILL_TO_CANONICAL[clean].forEach((canonical) => {
        expanded.add(canonical);
        const entry = CANONICAL_CATEGORIES.find((c) => c.slug === canonical);
        if (entry) {
          entry.aliases.forEach((a) => expanded.add(a));
        }
      });
      continue;
    }

    // Check if canonical or alias
    const canonical = normalizeCategorySlug(clean);
    expanded.add(canonical);
    const entry = CANONICAL_CATEGORIES.find((c) => c.slug === canonical);
    if (entry) {
      entry.aliases.forEach((a) => expanded.add(a));
    }
  }

  return Array.from(expanded);
}
