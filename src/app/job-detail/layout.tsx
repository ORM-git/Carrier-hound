import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Job Details | Career Monke",
  description: "View this role on Career Monke.",
  alternates: {
    canonical: "/job-detail",
  },
  openGraph: {
    title: "Job Details | Career Monke",
    description: "View this role on Career Monke.",
    url: "https://careermonke.com/job-detail",
  },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
