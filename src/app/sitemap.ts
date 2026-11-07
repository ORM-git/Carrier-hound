import { MetadataRoute } from "next";
import { execSync } from "child_process";

/**
 * lastmod is the date of the last git commit that touched the route's page
 * file (plus src/components for the landing page, whose content lives there).
 * That is the last time the page's content could actually have changed. When
 * git history is unavailable (e.g. a stripped deploy context) lastModified is
 * omitted rather than filled with a misleading uniform build timestamp.
 */
/**
 * Shallow checkouts (CI uses fetch-depth 1) have no per-path history: git log
 * returns the HEAD date for every path, which would emit a misleading uniform
 * date. Treat unknown history as shallow so lastModified is omitted instead.
 */
let shallowCache: boolean | undefined;
function isShallowRepo(): boolean {
  if (shallowCache !== undefined) return shallowCache;
  try {
    shallowCache =
      execSync("git rev-parse --is-shallow-repository", {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim() === "true";
  } catch {
    shallowCache = true;
  }
  return shallowCache;
}

function lastContentChange(paths: string[]): Date | undefined {
  if (isShallowRepo()) return undefined;
  try {
    const out = execSync(`git log -1 --format=%cI -- ${paths.join(" ")}`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out ? new Date(out) : undefined;
  } catch {
    return undefined;
  }
}

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://careermonke.com";

  return [
    {
      url: `${baseUrl}`,
      lastModified: lastContentChange(["src/app/page.tsx", "src/components"]),
      changeFrequency: "daily",
      priority: 1.0,
    },
    {
      url: `${baseUrl}/early-access`,
      lastModified: lastContentChange(["src/app/early-access"]),
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${baseUrl}/remote`,
      lastModified: lastContentChange(["src/app/remote"]),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/worldwide`,
      lastModified: lastContentChange(["src/app/worldwide"]),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/pricing`,
      lastModified: lastContentChange(["src/app/pricing"]),
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/signup`,
      lastModified: lastContentChange(["src/app/signup"]),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${baseUrl}/privacy-policy`,
      lastModified: lastContentChange(["src/app/privacy-policy"]),
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/terms-and-conditions`,
      lastModified: lastContentChange(["src/app/terms-and-conditions"]),
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/refund-policy`,
      lastModified: lastContentChange(["src/app/refund-policy"]),
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/contact`,
      lastModified: lastContentChange(["src/app/contact"]),
      changeFrequency: "monthly",
      priority: 0.7,
    },
  ];
}
