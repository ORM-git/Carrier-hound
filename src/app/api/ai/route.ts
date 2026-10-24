import { handleAiRequest } from "@/lib/ai/serviceHandler";

export const runtime = "edge";

export async function POST(req: Request) {
  return handleAiRequest(req);
}
