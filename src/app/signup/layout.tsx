import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Create your free account | Career Monke",
  description: "Create a free Career Monke account to save and track verified employer jobs.",
  alternates: {
    canonical: "/signup",
  },
  openGraph: {
    title: "Create your free account | Career Monke",
    description: "Create a free Career Monke account to save and track verified employer jobs.",
    url: "https://careermonke.com/signup",
  },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
