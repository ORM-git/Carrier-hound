import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Log in | CareerMonke",
  description: "Log in to CareerMonke to browse unindexed remote jobs sourced directly from verified employer career pages.",
  alternates: {
    canonical: "/login",
  },
  openGraph: {
    title: "Log in | CareerMonke",
    description: "Log in to CareerMonke to browse unindexed remote jobs sourced directly from verified employer career pages.",
    url: "https://careermonke.com/login",
  },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
