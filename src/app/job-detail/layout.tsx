import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Job Details | CareerMonke",
  description: "View this role on CareerMonke.",
  alternates: {
    canonical: "/job-detail",
  },
  openGraph: {
    title: "Job Details | CareerMonke",
    description: "View this role on CareerMonke.",
    url: "https://careermonke.com/job-detail",
  },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
