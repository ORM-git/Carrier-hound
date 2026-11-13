# Razorpay Webhook Route Handler

## Overview

This document specifies the server-side webhook handler for Razorpay billing events ported to Next.js Edge runtime for Cloudflare Pages deployment.

- **Route Path**: `/api/billing/razorpay/webhook`
- **Supported Methods**: `POST` (event ingestion), `OPTIONS` (CORS preflight)
- **Disallowed Methods**: Unhandled methods are rejected by Next.js route dispatching
- **Runtime**: `edge` (`export const runtime = "edge"`)

> [!WARNING]
> **Middleware Interception Notice (Live Cloudflare Webhook Readiness)**:
> This route handler implements the endpoint logic, but live Cloudflare webhook readiness is not achieved until early-access middleware is removed or modified in a separate PR; today, external requests to `/api/billing/razorpay/webhook` are intercepted by `src/middleware.ts` with HTTP 403 (early access gate).

> [!NOTE]
> This document intentionally specifies only the relative route path (`/api/billing/razorpay/webhook`). Domain names, protocols, and host URLs depend on the environment deployment target and are never hardcoded.

---

## Security & Verification Flow

### 1. Feature Flag Gating
When `NEXT_PUBLIC_BILLING_ENABLED !== "true"`, the route immediately halts and responds:
- **Status**: `503 Service Unavailable`
- **Body**: `{ "error": "Billing is currently unavailable", "code": "BILLING_DISABLED" }`

### 2. Configuration Validation
The route requires:
- `RAZORPAY_WEBHOOK_SECRET`: Shared webhook secret. If missing, responds `500 Internal Server Error` with body `{ "error": "Webhook secret is not configured" }` (omits any error code property).
- Key Environment Precedence: Evaluates `process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID || ""` to derive active server mode (`rzp_test_*` -> `test`, `rzp_live_*` -> `live`). If missing or invalid prefix, responds `500 Internal Server Error` with code `"RAZORPAY_CONFIG_INVALID"`.

### 3. Bounded Byte Ingestion & Size Limits (413)
To prevent Edge memory exhaustion from chunked, streamed, or missing `Content-Length` requests:
- Reads the request body stream chunk-by-chunk up to a hard ceiling of 256 KB (`MAX_BODY_BYTES = 262144`).
- If the accumulated bytes exceed the ceiling, the stream reader is cancelled immediately and the route responds with `413 Payload Too Large` (`PAYLOAD_TOO_LARGE`).

### 4. WebCrypto Signature Verification Primitive
Before JSON parsing or database operations:
1. Extracts the signature from `x-razorpay-signature` or `X-Razorpay-Signature` header (rejects with 400 `MISSING_SIGNATURE` if absent).
2. Converts the 64-character hexadecimal signature string into raw 32-byte binary format (`hexToBytes`).
3. Uses the native WebCrypto verification primitive `crypto.subtle.verify("HMAC", key, signatureBytes, rawBytes)` over the exact raw request bytes.
4. If verification returns false or signature is malformed, rejects with `400 Bad Request` (`INVALID_SIGNATURE`).

### 5. Zero Body Logging & PII Protection
- The raw request body is never passed to application loggers or written to disk.
- Structured logs record only non-sensitive execution metadata: `route`, `requestId`, `eventId`, `eventType`, `orderId`, and `durationMs`.

---

## Payload Shape & Event ID Resolution

1. **Top-Level Shape**:
   - Must be a non-null JSON object with a non-empty `event` string (rejects malformed payloads with 400 `MALFORMED_PAYLOAD`).
   - For fulfillment events (`order.paid` and `payment.captured`), an `order_id` must be present in `payload.order.entity.id` or `payload.payment.entity.order_id` (rejects with 400 `MISSING_ORDER_ID` if absent).
2. **Stable Validated Event Identifier**:
   - Resolved from `x-razorpay-event-id` header, or `payload.event_id`, or `payload.id`.
   - Fallback: Stable composite `${orderId}:${eventType}` (or `${paymentId}:${eventType}`).
   - Contains no non-deterministic timestamps or `Date.now()` fallbacks.

---

## Authoritative Order Validation & Fail-Closed DB Errors

### Authoritative Order Row
For fulfillment events:
1. Queries `payment_orders` by `provider_order_id`.
   - **Database Errors**: If the query fails, the route logs the incident, writes to `failed_events` if possible, and returns `500 Internal Server Error` (`DATABASE_ERROR`) to trigger provider retries. It does **not** treat a database error as a 404.
   - **Missing Row**: If the row does not exist, returns `404 Not Found` (`ORDER_NOT_FOUND`).
2. **Authoritative Provider & Mode**:
   - Requires `order.provider === "razorpay"` (rejects with 400 `INVALID_PROVIDER` otherwise).
   - Requires `order.mode === serverMode` (rejects with 400 `MODE_MISMATCH` if test/live modes conflict).
3. **User Derivation & Notes Guard**:
   - Authoritative user ID is derived directly from `order.user_id`.
   - If payload notes contain a user ID (`notes.user_id` / `notes.userId`), it must strictly match `order.user_id`. On mismatch, rejects with 400 `USER_MISMATCH`.

### Idempotency & Receipt Writing
1. **Deduplication Check (`webhook_events`)**:
   - Queries `webhook_events` for existing `event_id`.
   - If the query produces a database error, responds `500 Internal Server Error` (`DATABASE_ERROR`).
   - If an event is already recorded and the order is already in `paid` status, short-circuits with `200 OK` (`alreadyProcessed: true`) without re-running fulfillment.
2. **Atomic Fulfillment RPC (`fulfil_payment_order`)**:
   - Invokes `fulfil_payment_order` with `orderId`, `userId`, and `serverMode`.
   - If RPC returns an error or `success: false` (and order is not already paid), logs to `failed_events` and responds 500 without writing a receipt to `webhook_events`.
3. **Receipt Writing (`webhook_events`)**:
   - On successful fulfillment (or non-fulfillment terminal events such as `payment.failed`, `refund.created`), writes an upsert row to `webhook_events`.
   - **Fail-Closed on Write Error**: If the upsert fails, the route responds `500 Internal Server Error` (`RECEIPT_WRITE_FAILED`) instead of 200, ensuring the provider retries until the receipt is durably recorded.

---

## Offline Testing

The webhook implementation is verified offline without live database or payment network dependencies:
- **Test File**: `scripts/test-billing-webhook-route.ts`
- **Execution**: `npx tsx scripts/test-billing-webhook-route.ts`
- **Coverage**: 24 test scenarios verifying WebCrypto primitives, bounded byte streaming, gating, missing/invalid configuration, signature rejections, malformed payload shapes, database query failure-closed semantics, provider/mode/user validation, idempotent retries, duplicate suppression, and non-fulfillment event handling.

> [!NOTE]
> Offline test fixtures utilize mock database adapters to verify route branching, error handling, and state transitions. They do not assert production PostgreSQL engine-level transaction isolation or ACID row locks.
