import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Live Job Radar | CareerMonke",
  description: "Watch new unindexed remote roles arrive in real time on the CareerMonke live job radar.",
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
