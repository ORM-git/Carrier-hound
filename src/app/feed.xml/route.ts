import { GUIDE_ARTICLES } from "@/data/guides/articles";

// Static export: emitted as /feed.xml at build time.
export const dynamic = "force-static";

const BASE_URL = "https://careermonke.com";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** "Updated September 2026" -> UTC string, or null when unparseable. */
function toPubDate(updatedDate: string): string | null {
  const cleaned = updatedDate.replace(/^updated\s+/i, "").trim();
  const parsed = Date.parse(cleaned);
  return Number.isNaN(parsed) ? null : new Date(parsed).toUTCString();
}

export function GET() {
  const items = Object.values(GUIDE_ARTICLES).map((article) => {
    const link = `${BASE_URL}/remote/${article.slug}`;
    const pubDate = toPubDate(article.updatedDate);
    return [
      "    <item>",
      `      <title>${escapeXml(article.title)}</title>`,
      `      <link>${link}</link>`,
      `      <guid isPermaLink="true">${link}</guid>`,
      `      <description>${escapeXml(article.lede)}</description>`,
      `      <category>${escapeXml(article.label)}</category>`,
      pubDate ? `      <pubDate>${pubDate}</pubDate>` : null,
      "    </item>",
    ]
      .filter(Boolean)
      .join("\n");
  }).join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>CareerMonke Guides</title>
    <link>${BASE_URL}/remote</link>
    <description>Remote-work and job-search guides from CareerMonke.</description>
    <language>en-us</language>
${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
