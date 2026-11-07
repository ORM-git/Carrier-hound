import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Early Access | CareerMonke",
  description: "Join the CareerMonke early access list for unindexed remote jobs discovered directly from employer career pages.",
  alternates: {
    canonical: "/early-access",
  },
  openGraph: {
    title: "Early Access | CareerMonke",
    description: "Join the CareerMonke early access list for unindexed remote jobs discovered directly from employer career pages.",
    url: "https://careermonke.com/early-access",
  },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
