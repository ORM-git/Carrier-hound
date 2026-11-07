import { handleSignoutAllRequest } from "@/lib/account/signoutAllHandler";

export const runtime = "edge";

export async function POST(req: Request) {
  return handleSignoutAllRequest(req);
}
