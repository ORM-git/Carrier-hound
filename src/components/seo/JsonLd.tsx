import React from "react";
import { getRootStructuredData, RootJsonLdGraph } from "@/lib/seo/structuredData";

export interface JsonLdProps {
  data?: RootJsonLdGraph;
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
