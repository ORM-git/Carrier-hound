export const runtime = "edge";

import { handleActivateRequest } from "@/lib/billing/activate";

export async function POST(req: Request) {
  return handleActivateRequest(req);
}
