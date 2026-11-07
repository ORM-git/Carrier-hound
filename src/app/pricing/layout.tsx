import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Pricing | CareerMonke",
  description: "CareerMonke pricing: browse free, or upgrade to Pro for full job details, AI resume tailoring, and the live job radar.",
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
