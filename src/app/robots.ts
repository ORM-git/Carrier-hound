import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://careermonke.com";
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/onboarding"],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
