import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Live Job Radar | CareerMonke",
  description: "Discover fresh remote roles on the CareerMonke job radar.",
  alternates: {
    canonical: "/radar",
  },
  openGraph: {
    title: "Live Job Radar | CareerMonke",
    description: "Discover fresh remote roles on the CareerMonke job radar.",
    url: "https://careermonke.com/radar",
  },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
