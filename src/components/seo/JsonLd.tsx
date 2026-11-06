import React from "react";
import { getRootStructuredData } from "@/lib/seo/structuredData";

export interface JsonLdProps {
  /** Any JSON-LD node or graph; defaults to the root Organization/WebSite graph. */
  data?: Record<string, unknown>;
}

export function JsonLd({ data }: JsonLdProps = {}) {
  const jsonLd = data || getRootStructuredData();
  const safeJson = JSON.stringify(jsonLd).replace(/</g, "\\u003c");

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: safeJson,
      }}
    />
  );
}

export default JsonLd;
