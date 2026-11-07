import type { Metadata } from "next";
import WorldwideClient from "@/components/worldwide/WorldwideClient";
import { getWorldwideCompanies } from "@/lib/api/worldwide";

export const metadata: Metadata = {
  title: "Worldwide Companies | CareerMonke",
  description: "Browse verified employers hiring remote roles worldwide, discovered directly from company career pages.",
};

export default async function WorldwidePage() {
  const companies = await getWorldwideCompanies();
  return <WorldwideClient initialCompanies={companies} />;
}
