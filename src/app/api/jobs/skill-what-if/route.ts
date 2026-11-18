import { handleSkillWhatIfRequest } from "@/lib/skill-what-if/handler";

export const runtime = "edge";

export async function GET(req: Request) {
  return handleSkillWhatIfRequest(req);
}
