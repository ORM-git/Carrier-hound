import { handleAccountExportRequest } from "@/lib/account/exportHandler";

export const runtime = "edge";

export async function POST(req: Request) {
  return handleAccountExportRequest(req);
}
