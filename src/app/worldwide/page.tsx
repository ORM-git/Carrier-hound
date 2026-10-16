import WorldwideClient from "@/components/worldwide/WorldwideClient";
import { getWorldwideCompanies } from "@/lib/api/worldwide";

export default async function WorldwidePage() {
  const companies = await getWorldwideCompanies();
  return <WorldwideClient initialCompanies={companies} />;
}
