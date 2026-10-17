import { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/siteUrl";
import { GUIDE_ARTICLES } from "@/data/guides/articles";
import { ROLE_GUIDES } from "@/data/guides/roles";
import { CATEGORY_LANDINGS } from "@/data/guides/categories";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = getSiteUrl();

  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: `${baseUrl}`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1.0,
    },
    {
      url: `${baseUrl}/jobs`,
      lastModified: new Date(),
      changeFrequency: "hourly",
      priority: 1.0,
    },
    {
      url: `${baseUrl}/worldwide`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/remote`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/login`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${baseUrl}/privacy-policy`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${baseUrl}/terms-and-conditions`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];

  const articleRoutes: MetadataRoute.Sitemap = Object.keys(GUIDE_ARTICLES).map((slug) => ({
    url: `${baseUrl}/remote/${slug}`,
    lastModified: new Date(),
    changeFrequency: "weekly",
    priority: 0.7,
  }));

  const roleRoutes: MetadataRoute.Sitemap = Object.keys(ROLE_GUIDES).map((role) => ({
    url: `${baseUrl}/remote/${role}/titles`,
    lastModified: new Date(),
    changeFrequency: "weekly",
    priority: 0.7,
  }));

  const categoryRoutes: MetadataRoute.Sitemap = Object.keys(CATEGORY_LANDINGS).map((cat) => ({
    url: `${baseUrl}/remote/jobs/${cat}`,
    lastModified: new Date(),
    changeFrequency: "daily",
    priority: 0.8,
  }));

  return [...staticRoutes, ...articleRoutes, ...roleRoutes, ...categoryRoutes];
}
