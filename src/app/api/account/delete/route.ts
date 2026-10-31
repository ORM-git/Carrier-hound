import { handleAccountDeleteRequest } from "@/lib/account/deleteHandler";

export const runtime = "edge";

export async function POST(req: Request) {
  return handleAccountDeleteRequest(req);
}
