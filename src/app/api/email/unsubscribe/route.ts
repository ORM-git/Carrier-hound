import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/ai/serviceHandler";
import {
  verifyUnsubscribeToken,
  processUnsubscribe,
  renderUnsubscribeConfirmationHtml,
  renderUnsubscribeSuccessHtml,
  renderUnsubscribeErrorHtml,
} from "@/lib/email/unsubscribe";

export const runtime = "edge";

/**
 * GET /api/email/unsubscribe?token=<signed_token>
 * Renders a minimal confirmation page with an unsubscribe button.
 * Does NOT perform suppression on GET (protects against email scanner pre-fetching).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");

    if (!token) {
      const errorHtml = renderUnsubscribeErrorHtml("Missing required 'token' parameter.");
      return new Response(errorHtml, {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const verification = await verifyUnsubscribeToken(token);
    if (!verification.valid) {
      const errorHtml = renderUnsubscribeErrorHtml(
        `This unsubscribe link is invalid or has expired: ${verification.reason}`
      );
      return new Response(errorHtml, {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Render minimal confirmation page with form button targeting POST
    const html = renderUnsubscribeConfirmationHtml({
      email: verification.email,
      topic: verification.topic,
      token,
      postUrl: "/api/email/unsubscribe",
    });

    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (err: any) {
    const errorHtml = renderUnsubscribeErrorHtml(
      err?.message || "Internal server error rendering unsubscribe confirmation."
    );
    return new Response(errorHtml, {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

/**
 * POST /api/email/unsubscribe
 * Performs the actual email suppression:
 * - RFC 8058 One-Click Unsubscribe (List-Unsubscribe=One-Click from email client).
 * - Human submission of the confirmation form from the GET page.
 */
export async function POST(req: Request) {
  const acceptHeader = req.headers.get("accept") || "";
  const prefersHtml =
    acceptHeader.includes("text/html") && !acceptHeader.includes("application/json");

  try {
    const url = new URL(req.url);
    let token = url.searchParams.get("token");

    // Extract token from request body if not in query params
    if (!token) {
      const contentType = req.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        try {
          const body = await req.json();
          token = body?.token;
        } catch {}
      } else if (
        contentType.includes("application/x-www-form-urlencoded") ||
        contentType.includes("multipart/form-data")
      ) {
        try {
          const text = await req.text();
          const params = new URLSearchParams(text);
          token = params.get("token");
        } catch {}
      }
    }

    if (!token) {
      if (prefersHtml) {
        return new Response(
          renderUnsubscribeErrorHtml("Missing required 'token' parameter."),
          {
            status: 400,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }
        );
      }
      return NextResponse.json(
        { ok: false, error: "Missing required 'token' parameter." },
        { status: 400 }
      );
    }

    let supabaseAdmin: any;
    try {
      supabaseAdmin = getSupabaseAdminClient(undefined, true);
    } catch (_err: any) {
      if (prefersHtml) {
        return new Response(
          renderUnsubscribeErrorHtml("Database configuration unavailable."),
          {
            status: 500,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }
        );
      }
      return NextResponse.json(
        { ok: false, error: "Database configuration unavailable." },
        { status: 500 }
      );
    }

    const result = await processUnsubscribe(supabaseAdmin, token);

    if (!result.ok) {
      if (prefersHtml) {
        return new Response(renderUnsubscribeErrorHtml(result.message), {
          status: result.status,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return NextResponse.json(
        { ok: false, error: result.message },
        { status: result.status }
      );
    }

    // Success response
    if (prefersHtml) {
      return new Response(
        renderUnsubscribeSuccessHtml({
          email: result.email,
          topic: result.topic,
          message: result.message,
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        unsubscribed: true,
        message: result.message,
        email: result.email,
        topic: result.topic,
      },
      { status: 200 }
    );
  } catch (err: any) {
    if (prefersHtml) {
      return new Response(
        renderUnsubscribeErrorHtml(err?.message || "Internal unsubscribe error."),
        {
          status: 500,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }
      );
    }
    return NextResponse.json(
      { ok: false, error: err?.message || "Internal unsubscribe error." },
      { status: 500 }
    );
  }
}
