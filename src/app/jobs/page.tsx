import JobsClient from "./JobsClient";
import { getInitialPublicJobs } from "@/lib/jobs/initialJobs";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const initialData = await getInitialPublicJobs(50);
  return <JobsClient initialData={initialData} />;
}
