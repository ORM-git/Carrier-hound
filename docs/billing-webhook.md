# Razorpay Webhook Route Handler

## Overview

This document specifies the server-side webhook handler for Razorpay billing events ported to Next.js Edge runtime for Cloudflare Pages deployment.

- **Route Path**: `/api/billing/razorpay/webhook`
- **Supported Methods**: `POST` (event ingestion), `OPTIONS` (CORS preflight)
- **Disallowed Methods**: `GET`, `PUT`, `DELETE`, `PATCH`, etc. return `405 Method Not Allowed` with `Allow: POST, OPTIONS`
- **Runtime**: `edge` (`export const runtime = "edge"`)

> **Note**: This document intentionally specifies only the relative route path (`/api/billing/razorpay/webhook`). Domain names, protocols, and host URLs depend on the environment deployment target and are never hardcoded.

---

## Security & Verification Flow

### 1. Feature Flag Gating
When `NEXT_PUBLIC_BILLING_ENABLED !== "true"`, the route immediately halts and responds:
- **Status**: `503 Service Unavailable`
- **Body**: `{ "error": "Billing is currently disabled", "code": "BILLING_DISABLED" }`

### 2. Configuration Validation
The route requires:
- `RAZORPAY_WEBHOOK_SECRET`: Secret shared between the application and the Razorpay webhook dashboard.
- `RAZORPAY_KEY_ID`: Server key used to infer active credentials mode (`rzp_test_*` -> `test`, `rzp_live_*` -> `live`).

If missing or invalid, responds `500 Internal Server Error` (`RAZORPAY_CONFIG_MISSING` / `RAZORPAY_CONFIG_INVALID`).

### 3. Timing-Safe Web Crypto Signature Verification
Before any payload parsing or database operations take place:
1. The route extracts the signature from the `X-Razorpay-Signature` (or `x-razorpay-signature`) header.
2. If missing, rejects with `400 Bad Request` (`MISSING_SIGNATURE`).
3. Computes the HMAC-SHA256 of the raw UTF-8 request body string against `RAZORPAY_WEBHOOK_SECRET` using Web Crypto API (`crypto.subtle`).
4. Compares the computed digest with the received signature in constant time across fixed-length 64-character SHA-256 digests (`constantTimeEqual`) to prevent timing side-channel attacks and length leakage.
5. If signatures do not match, rejects with `400 Bad Request` (`INVALID_SIGNATURE`).

### 4. Zero Body Logging & PII Protection
- The raw request body is never passed to application loggers or written to disk.
- Structured logs record only non-sensitive execution metadata: `route`, `requestId`, `eventId`, `eventType`, `orderId`, and `durationMs`.

---

## Idempotency & Deduplication

Webhooks from payment providers may be retried across network interruptions or transient timeouts.

1. **Event Identifier**:
   The unique event ID is resolved from:
   - `X-Razorpay-Event-Id` / `x-razorpay-event-id` header
   - `payload.event_id` / `payload.id`
   - Fallback composite identifier: `${order_id}:${event_type}`
2. **Deduplication Check (`webhook_events`)**:
   - The route queries `webhook_events` for existing entries matching `event_id`.
   - If an event is already recorded and the associated order is in `paid` status, the route short-circuits and returns `200 OK` with `{ "ok": true, "alreadyProcessed": true }`.
3. **Commit Timing**:
   - The event row is written into `webhook_events` **only after** order fulfillment succeeds or when processing ignorable terminal events (e.g., `payment.failed`, `refund.created`).
   - If order fulfillment encounters a transient error or fails, the event is **not** recorded in `webhook_events`, allowing Razorpay's exponential-backoff retries to succeed on subsequent delivery.

---

## Fulfillment & Dead-Letter Handling

### Order Verification
For fulfillment events (`payment.captured` or `order.paid`):
1. Resolves `order_id` from `payload.payload.payment.entity.order_id` or `payload.payload.order.entity.id`.
2. Queries `payment_orders` table by `provider_order_id`. If not found, responds `404 Not Found` (`ORDER_NOT_FOUND`).
3. Validates environment mode match: verifies `order.mode` equals the server key mode (`test` vs `live`). On mismatch, returns `400 Bad Request` (`MODE_MISMATCH`).

### Fulfillment Execution (`fulfil_payment_order` RPC)
The route invokes the database atomic stored procedure `fulfil_payment_order`:
- Parameters: `p_provider_order_id`, `p_user_id`, `p_expected_mode`
- Handles concurrent executions atomically via database row locks.

### Error Handling & Dead-Letter Queue
- If `fulfil_payment_order` returns `success: false` (and is not already paid), or if an unexpected exception occurs:
  1. The error is written to `failed_events` via `recordFailedEvent` for auditing.
  2. The route returns `500 Internal Server Error`.
  3. No deduplication record is written to `webhook_events`, ensuring Razorpay retries the webhook.

---

## Offline Testing

The webhook implementation is verified offline without live database or payment network dependencies:
- **Test File**: `scripts/test-billing-webhook-route.ts`
- **Execution**: `npx tsx scripts/test-billing-webhook-route.ts`
- **Coverage**: 18 test cases including timing attacks, missing headers, invalid signatures, malformed payloads, replay attacks, RPC failures, and non-fulfillment events.
