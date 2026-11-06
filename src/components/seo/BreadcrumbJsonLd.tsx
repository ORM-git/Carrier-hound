import React from "react";
import { getBreadcrumbJsonLd } from "@/lib/seo/structuredData";
import { JsonLd } from "./JsonLd";

export interface BreadcrumbJsonLdProps {
  /** Ordered trail, home first, e.g. [{ name: "Home", path: "/" }, { name: "Pricing", path: "/pricing" }] */
  trail: { name: string; path: string }[];
}

/** Renders BreadcrumbList JSON-LD for a public page. No visual output. */
export function BreadcrumbJsonLd({ trail }: BreadcrumbJsonLdProps) {
  return <JsonLd data={getBreadcrumbJsonLd(trail)} />;
}

export default BreadcrumbJsonLd;
