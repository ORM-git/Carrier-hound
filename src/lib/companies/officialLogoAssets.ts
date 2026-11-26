/**
 * Official company marks bundled with the app, used by the ticker only when a company has no
 * hosted logo in companies.logo_url. Each file was fetched from the company's own website
 * (favicon, touch icon or JSON-LD logo), never from an ATS, job board or aggregator.
 * Lookup is an exact match on the normalized company name, so a similarly named employer
 * never inherits another company's mark. Hosted logos always win over these.
 */
const BASE = "/company-logos-static/";

export const OFFICIAL_LOGO_FILES: Readonly<Record<string, string>> = {
  asana: "asana.png",
  cloudflare: "cloudflare.png",
  hellofresh: "hellofresh.png",
  mongodb: "mongodb.png",
  netlify: "netlify.png",
  netskope: "netskope.png",
  okta: "okta.png",
  pagerduty: "pagerduty.png",
  reddit: "reddit.png",
  wolt: "wolt.png",
};

const CORP_SUFFIX = /\s+(inc|incorporated|llc|ltd|limited|corp|corporation|co|gmbh|plc)$/;

export function normalizeCompanyKey(name: string | null | undefined): string {
  if (!name || typeof name !== "string") return "";
  return name
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(CORP_SUFFIX, "");
}

export function officialLogoFor(name: string | null | undefined): string | null {
  const key = normalizeCompanyKey(name);
  if (!key || !Object.prototype.hasOwnProperty.call(OFFICIAL_LOGO_FILES, key)) return null;
  return BASE + OFFICIAL_LOGO_FILES[key];
}

export function isOfficialLogoPath(raw: string | null | undefined): boolean {
  return typeof raw === "string" && raw.startsWith(BASE) && Object.values(OFFICIAL_LOGO_FILES).some((f) => BASE + f === raw);
}
