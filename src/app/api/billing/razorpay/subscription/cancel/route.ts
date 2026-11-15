import { DELETE as cancelSubscriptionHandler } from "../route";

export const runtime = "edge";

export async function POST(req: Request) {
  return cancelSubscriptionHandler(req);
}

export async function DELETE(req: Request) {
  return cancelSubscriptionHandler(req);
}
