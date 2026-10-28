/**
 * Polite Fetcher with domain rate limiting, timeout, retries, and robots.txt compliance.
 */

const USER_AGENT = 'CareerMonkeBot/1.0 (+https://careermonke.com; ingestion@careermonke.com)';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
const MIN_DOMAIN_INTERVAL_MS = 1000; // 1 request per second per domain

// Track timestamp of last request per domain
const lastRequestByDomain = new Map<string, number>();

// Cache robots.txt disallow rules per domain
const robotsCache = new Map<string, string[]>();

// Explicitly banned scrapable domains (as requested)
const FORBIDDEN_DOMAINS = [
  'linkedin.com',
  'indeed.com',
  'naukri.com',
  'jobright.ai',
  'jobright.com',
  'glassdoor.com',
  'workday.com',
  'myworkdayjobs.com',
];

/**
 * Sleeps for specified milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Enforces polite 1 req/sec pacing per domain.
 */
async function throttleDomain(hostname: string, intervalMs = MIN_DOMAIN_INTERVAL_MS): Promise<void> {
  const now = Date.now();
  const last = lastRequestByDomain.get(hostname) || 0;
  const elapsed = now - last;
  if (elapsed < intervalMs) {
    const waitTime = intervalMs - elapsed;
    await sleep(waitTime);
  }
  lastRequestByDomain.set(hostname, Date.now());
}

/**
 * Checks if target URL domain is strictly forbidden.
 */
export function isForbiddenDomain(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return FORBIDDEN_DOMAINS.some(
      (banned) => hostname === banned || hostname.endsWith(`.${banned}`)
    );
  } catch {
    return false;
  }
}

/**
 * Inspects domain robots.txt for disallow rules matching User-Agent or *.
 */
export async function isAllowedByRobotsTxt(url: string): Promise<boolean> {
  try {
    const parsedUrl = new URL(url);
    const domain = parsedUrl.origin;
    const pathname = parsedUrl.pathname;

    if (!robotsCache.has(domain)) {
      try {
        const robotsUrl = `${domain}/robots.txt`;
        const res = await fetch(robotsUrl, {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(6000),
        });

        if (res.ok) {
          const body = await res.text();
          const disallowedPaths: string[] = [];
          const lines = body.split('\n').map((l) => l.trim());
          let appliesToUs = false;

          for (const line of lines) {
            if (/^User-agent:\s*(CareerMonkeBot|\*)/i.test(line)) {
              appliesToUs = true;
            } else if (/^User-agent:/i.test(line)) {
              appliesToUs = false;
            } else if (appliesToUs && /^Disallow:\s*(.*)/i.test(line)) {
              const match = line.match(/^Disallow:\s*(.*)/i);
              const path = match ? match[1].trim() : '';
              if (path) disallowedPaths.push(path);
            }
          }
          robotsCache.set(domain, disallowedPaths);
        } else {
          // If 404 or not found, robots.txt doesn't disallow
          robotsCache.set(domain, []);
        }
      } catch {
        robotsCache.set(domain, []);
      }
    }

    const disallows = robotsCache.get(domain) || [];
    for (const disallow of disallows) {
      if (disallow === '/') return false;
      if (pathname.startsWith(disallow)) return false;
    }

    return true;
  } catch {
    return true;
  }
}

export interface PoliteFetchOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  skipRobotsCheck?: boolean;
  rateLimitMs?: number;
}

/**
 * Performs a polite HTTP request with rate limiting, retries, and robots.txt enforcement.
 */
export async function politeFetch(url: string, options: PoliteFetchOptions = {}): Promise<Response> {
  if (isForbiddenDomain(url)) {
    throw new Error(`Scraping forbidden for target domain: ${url}`);
  }

  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = MAX_RETRIES,
    skipRobotsCheck = false,
    rateLimitMs,
    headers = {},
    ...rest
  } = options;

  if (!skipRobotsCheck) {
    const allowed = await isAllowedByRobotsTxt(url);
    if (!allowed) {
      throw new Error(`Access disallowed by robots.txt: ${url}`);
    }
  }

  const parsedUrl = new URL(url);
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt <= retries) {
    await throttleDomain(parsedUrl.hostname, rateLimitMs || MIN_DOMAIN_INTERVAL_MS);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        ...rest,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json, text/xml, application/xml, text/plain, */*',
          ...headers,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle 429 Too Many Requests with retry
      if (response.status === 429 && attempt < retries) {
        attempt++;
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000 * Math.pow(2, attempt);
        console.warn(`[politeFetch] 429 received from ${parsedUrl.hostname}. Retrying in ${waitMs}ms...`);
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status} (${response.statusText}) for ${url}`);
      }

      return response;
    } catch (err: any) {
      lastError = err;
      attempt++;
      if (attempt <= retries) {
        const backoffMs = 1500 * Math.pow(2, attempt - 1);
        console.warn(
          `[politeFetch] Attempt ${attempt} failed for ${url} (${err.message}). Retrying in ${backoffMs}ms...`
        );
        await sleep(backoffMs);
      }
    }
  }

  throw lastError || new Error(`Failed to fetch ${url} after ${retries + 1} attempts`);
}

/**
 * Convenient wrapper to fetch and parse JSON with politeFetch.
 */
export async function politeFetchJson<T>(url: string, options?: PoliteFetchOptions): Promise<T> {
  const res = await politeFetch(url, options);
  return (await res.json()) as T;
}

/**
 * Convenient wrapper to fetch raw text/XML with politeFetch.
 */
export async function politeFetchText(url: string, options?: PoliteFetchOptions): Promise<string> {
  const res = await politeFetch(url, options);
  return await res.text();
}
