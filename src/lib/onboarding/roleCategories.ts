/**
 * Saved roles -> job `category` ids (the values ingestion writes: scripts/scraper/enrichment.py
 * assign_legacy_category). Only roles from the onboarding taxonomy map, and only where a job
 * category really exists. A custom/legacy role keeps its text in `roles` but adds no category;
 * no id is ever invented from free text.
 */
import { ONBOARDING_CATEGORIES } from "@/data/onboardingCategories";

const ROLE_OVERRIDES: Record<string, string> = {
  "QA / Test Engineer": "qa-testing",
  "DevOps / Cloud Engineer": "devops",
  "Site Reliability Engineer (SRE)": "devops",
  "Data Scientist": "data",
  "Data Engineer": "data",
};

// Subgroup name -> job category. Subgroups without a matching job category are left out on purpose.
const SUBGROUP_CATEGORY: Record<string, string> = {
  "Software Engineering": "engineering",
  "AI & Data Science": "ai",
  "Architecture & Security": "engineering",
  "Growth & Digital Marketing": "marketing",
  "Brand & Content": "marketing",
  "Product Marketing": "marketing",
  "Accounting & Audit": "finance",
  "Corporate Finance & Analysis": "finance",
  "Product Management": "product",
  "Design & UX": "design",
  "Human Resource": "hr",
  "Inside & Inbound Sales": "sales",
  "Enterprise & Direct Sales": "sales",
};

const ROLE_TO_CATEGORY = new Map<string, string>();
for (const cat of ONBOARDING_CATEGORIES) {
  for (const sg of cat.subgroups) {
    for (const role of sg.roles) {
      const id = ROLE_OVERRIDES[role] ?? SUBGROUP_CATEGORY[sg.name];
      if (id) ROLE_TO_CATEGORY.set(role.toLowerCase(), id);
    }
  }
}

/** Job category ids for the given roles, de-duplicated in first-seen order. */
export function categoriesForRoles(roles: readonly string[]): string[] {
  const out: string[] = [];
  for (const role of roles) {
    const id = ROLE_TO_CATEGORY.get(role.trim().toLowerCase());
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** True when the role is one of the taxonomy roles (case-insensitive). */
export function isTaxonomyRole(role: string): boolean {
  const r = role.trim().toLowerCase();
  return ONBOARDING_CATEGORIES.some((c) => c.subgroups.some((sg) => sg.roles.some((x) => x.toLowerCase() === r)));
}
