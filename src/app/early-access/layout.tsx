import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Early Access | CareerMonke",
  description: "Join the CareerMonke early access list for unindexed remote jobs discovered directly from employer career pages.",
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
