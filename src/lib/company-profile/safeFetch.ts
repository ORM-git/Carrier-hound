import { fetchWithTimeout, type FetchWithTimeoutOptions } from "@/lib/companies/logoResolver";
import { parseRetryAfter, WikidataHttpError } from "./wikidata";

export const COMPANY_PAGE_MAX_BYTES = 2 * 1024 * 1024;
export interface SafeFetchCompanyOptions { allowNotFound?: boolean }

/** The existing logo resolver pins public DNS results and validates every manual redirect. */
export async function safeFetchCompanyPage(rawUrl: string, transportOptions: FetchWithTimeoutOptions = {}, options: SafeFetchCompanyOptions = {}): Promise<{ url: string; contentType: string; text: string; status: number }> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("Invalid company source URL"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Company source must be a credential-free HTTP(S) URL");
  const response = await fetchWithTimeout(url.href, { ...transportOptions, timeoutMs: transportOptions.timeoutMs ?? 10_000, maxRedirects: transportOptions.maxRedirects ?? 3 });
  if (!response.ok && !(options.allowNotFound && response.status === 404)) throw new Error(`Company source returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (!/^(text\/html|text\/plain|application\/xhtml\+xml|application\/rss\+xml|application\/atom\+xml|application\/xml)(;|$)/i.test(contentType)) throw new Error("Company source content type is not HTML or feed XML");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > COMPANY_PAGE_MAX_BYTES) throw new Error("Company source exceeds 2MB");
  return { url: (response as Response & { url?: string }).url || url.href, contentType, text: new TextDecoder().decode(bytes), status: response.status };
}

export const WIKIDATA_USER_AGENT = "CareerMonkeBot/1.0 (https://careermonke.com; company-profile enrichment)";

/** Wikidata Action API only: same pinned-DNS transport, host-locked, JSON only, descriptive bot User-Agent. */
export async function safeFetchWikidataJson(rawUrl: string, transportOptions: FetchWithTimeoutOptions = {}): Promise<{ url: string; contentType: string; text: string; status: number }> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("Invalid Wikidata URL"); }
  if (url.protocol !== "https:" || url.hostname !== "www.wikidata.org" || url.pathname !== "/w/api.php" || url.username || url.password) throw new Error("Only the Wikidata Action API is allowed");
  const response = await fetchWithTimeout(url.href, {
    ...transportOptions, timeoutMs: transportOptions.timeoutMs ?? 10_000, maxRedirects: 0,
    customFetch: (target, init) => (transportOptions.customFetch || fetch)(target, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), "User-Agent": WIKIDATA_USER_AGENT } }),
  });
  if (!response.ok) throw new WikidataHttpError(response.status, parseRetryAfter(response.headers.get("retry-after"), Date.now()));
  const contentType = response.headers.get("content-type") || "";
  if (!/^application\/json(;|$)/i.test(contentType)) throw new Error("Wikidata response is not JSON");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > COMPANY_PAGE_MAX_BYTES) throw new Error("Wikidata response exceeds 2MB");
  return { url: url.href, contentType, text: new TextDecoder().decode(bytes), status: response.status };
}
