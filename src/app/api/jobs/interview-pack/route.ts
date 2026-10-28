import { handleInterviewPackRequest } from "@/lib/interview-pack/handler";

export const runtime = "edge";

export async function GET(req: Request) {
  return handleInterviewPackRequest(req);
}
