/**
 * Where an apply link GOES, decided from the URL alone (checklist #37). The job's source / provider is
 * deliberately not an input: an aggregator-sourced job can link to an employer board, and an ATS-sourced
 * job's destination is proven by its URL, not by its source field. Pure; not wired into any product path.
 *
 * - employer_board: exact ATS board host + first path segment equal to a registry token for that ATS.
 * - aggregator_platform: host equals, or is a dot-boundary subdomain of, an aggregator we ingest.
 * - unknown: everything else, incl. unknown tokens on shared ATS hosts, non-http(s), credentials,
 *   unparseable input. Unknown is never assumed employer.
 */
import registry from "../../../data/ats-company-registry.json";

export type ApplyDestinationKind = "employer_board" | "aggregator_platform" | "unknown";

export interface ApplyDestination {
  kind: ApplyDestinationKind;
  domain: string | null;
  matchedToken?: string;
}

/** Aggregator sites the pipelines ingest: scripts/adapters/{adzuna,arbeitnow,remotive,remoteok,weworkremotely}.ts
 * and JobSpy sites in scripts/scraper/fetch_aggregators_and_india.py (JOBSPY_SITES). */
export const AGGREGATOR_DOMAINS = [
  "adzuna.com",
  "adzuna.in",
  "arbeitnow.com",
  "remotive.com",
  "remoteok.com",
  "weworkremotely.com",
  "linkedin.com",
  "indeed.com",
  "naukri.com",
] as const;

/** Board hosts in the documented shape <host>/<token>/... (scripts/test-board-discovery.ts fixtures). */
const ATS_BOARD_HOSTS: Record<string, string> = {
  "boards.greenhouse.io": "greenhouse",
  "jobs.lever.co": "lever",
  "jobs.ashbyhq.com": "ashby",
};

const REGISTRY_TOKENS = new Set(
  (registry as Array<{ ats?: string; token?: string }>)
    .filter((e) => e.ats && e.token)
    .map((e) => `${e.ats}:${e.token!.toLowerCase()}`),
);

export function classifyApplyDestination(applyUrl: string | null | undefined): ApplyDestination {
  let url: URL;
  try {
    url = new URL(String(applyUrl ?? "").trim());
  } catch {
    return { kind: "unknown", domain: null };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname) {
    return { kind: "unknown", domain: null };
  }
  const host = url.hostname; // already lowercased by URL

  const ats = ATS_BOARD_HOSTS[host];
  if (ats) {
    // Raw segment, not decoded: registry tokens are plain slugs, so an encoded segment stays unknown.
    const token = (url.pathname.split("/")[1] || "").toLowerCase();
    return token && REGISTRY_TOKENS.has(`${ats}:${token}`)
      ? { kind: "employer_board", domain: host, matchedToken: token }
      : { kind: "unknown", domain: host };
  }

  if (AGGREGATOR_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
    return { kind: "aggregator_platform", domain: host };
  }
  return { kind: "unknown", domain: host };
}
