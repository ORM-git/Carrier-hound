/**
 * Pure helper to construct the canonical /jobs target URL,
 * strictly preserving the raw query string and URL hash while guaranteeing host safety.
 */
export function buildJobsRedirectUrl(search: string = "", hash: string = ""): string {
  let cleanSearch = (search || "").trim();
  if (cleanSearch && !cleanSearch.startsWith("?")) {
    cleanSearch = `?${cleanSearch}`;
  }
  if (cleanSearch === "?") {
    cleanSearch = "";
  }

  let cleanHash = (hash || "").trim();
  if (cleanHash && !cleanHash.startsWith("#")) {
    cleanHash = `#${cleanHash}`;
  }
  if (cleanHash === "#") {
    cleanHash = "";
  }

  const destination = `/jobs${cleanSearch}${cleanHash}`;

  // Strict host isolation: Destination must always start with relative path "/jobs", never protocol-relative or absolute URL
  if (!destination.startsWith("/jobs") || destination.startsWith("//")) {
    return "/jobs";
  }

  return destination;
}
