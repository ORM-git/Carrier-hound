import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Pricing | CareerMonke",
  description: "CareerMonke pricing: one-time prepaid plans for full access to verified unindexed remote job listings.",
  alternates: {
    canonical: "/pricing",
  },
  openGraph: {
    title: "Pricing | CareerMonke",
    description: "CareerMonke pricing: one-time prepaid plans for full access to verified unindexed remote job listings.",
    url: "https://careermonke.com/pricing",
  },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
