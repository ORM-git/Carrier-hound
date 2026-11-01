import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "edge";

const NO_CACHE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

export async function GET() {
  return new NextResponse(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: NO_CACHE_HEADERS,
  });
}

export async function HEAD() {
  return new NextResponse(null, {
    status: 200,
    headers: NO_CACHE_HEADERS,
  });
}
