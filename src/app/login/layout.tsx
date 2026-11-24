import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Log in | Career Monke",
  description: "Log in to Career Monke to browse verified employer jobs.",
  alternates: {
    canonical: "/login",
  },
  openGraph: {
    title: "Log in | Career Monke",
    description: "Log in to Career Monke to browse verified employer jobs.",
    url: "https://careermonke.com/login",
  },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
