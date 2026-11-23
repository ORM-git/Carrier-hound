/** Validate and normalize same-site destinations used across login, callback and middleware. */
export function getValidReturnUrl(targetUrl: string | null | undefined, fallback = "/jobs"): string {
  if (!targetUrl) return fallback;
  const target = targetUrl.trim();
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\") || /[\x00-\x1F\x7F]/.test(target)) return fallback;
  try {
    const decoded = decodeURIComponent(target);
    if (decoded.startsWith("//") || decoded.includes("\\") || /[\x00-\x1F\x7F]/.test(decoded)) return fallback;
    if (decoded.includes("%")) {
      const twice = decodeURIComponent(decoded);
      if (twice.startsWith("//") || twice.includes("\\") || /[\x00-\x1F\x7F]/.test(twice)) return fallback;
    }
  } catch {
    return fallback;
  }
  const path = target.split(/[?#]/)[0].toLowerCase();
  if (path === "/login" || path === "/signup" || path.startsWith("/auth")) return fallback;
  if (path === "/onboarding" && target.includes("?")) {
    const params = new URLSearchParams(target.slice(target.indexOf("?") + 1));
    const nested = params.get("next");
    if (nested) {
      if (nested.split(/[?#]/)[0].toLowerCase() === "/onboarding") return fallback;
      params.set("next", getValidReturnUrl(nested, fallback));
      return `/onboarding?${params.toString()}`;
    }
  }
  if (path === "/dashboard" || path.startsWith("/dashboard/") || path.includes("/interview-pack") || path.includes("/skill-what-if")) return "/jobs";
  return target;
}
