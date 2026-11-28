/**
 * Stable browsing sessions for a ranked, bounded job feed (row 69). Pure and stateless on the server:
 * works on Cloudflare edge and Node (Web Crypto only), needs no table, cache or process-local state.
 *
 * Contract
 * - The first page fixes the session's ordered membership: the full ranked, capped list (at most MAX_MEMBERS ids).
 * - The server returns page 1 rows plus one signed continuation per later page. Each continuation carries exactly
 *   that page's ids, in order, the session's issue time, page index and page size, and an HMAC over all of it and
 *   over the caller's binding (user, tier, effective filters, sort, scoring/preferences revision, page size).
 * - Serving page k: verify, then load ONLY those ids under the same current eligibility filters as any listing and
 *   return survivors in snapshot order (orderSurvivors). Inactive/hidden/deleted ids drop out; nothing new enters;
 *   no other member moves. New arrivals appear only in a new session (refresh / new query).
 * - Rejected safely (no offset fallback): malformed, oversized, forged or other-binding (cannot be told apart
 *   without leaking the binding), expired, future-dated, wrong page size, out-of-range page.
 * - Nothing private is in a token: job ids, times and counters only. The binding is never encoded, only MACed.
 *
 * Needs a dedicated server-only secret (>= 32 chars). Missing/short secret fails closed.
 */

import { UUID_REGEX } from "./cursor";

export const FEED_SESSION_VERSION = "fs1";
/** Upper bound on session membership: the recommended pool size. */
export const MAX_MEMBERS = 1000;
export const MAX_PAGE_SIZE = 100;
/** Default session lifetime; a continuation older than this is rejected and the client starts a new session. */
export const DEFAULT_TTL_MS = 30 * 60 * 1000;
/** Tolerated clock difference between workers for issue times in the future. */
export const MAX_CLOCK_SKEW_MS = 60 * 1000;
/** Longest acceptable token: MAX_PAGE_SIZE ids at 22 chars, plus header, counters and a 43-char MAC. */
export const MAX_TOKEN_LENGTH = MAX_PAGE_SIZE * 22 + 160;
const MIN_SECRET_LENGTH = 32;

export type BindingValue = string | number | boolean | null | readonly (string | number | boolean)[];
/** Everything a continuation must match. Callers pass already-normalized values (sorted where order is irrelevant). */
export type SessionBinding = Readonly<Record<string, BindingValue>>;

export class FeedSessionSecretError extends Error {
  constructor() {
    super("feed session secret is missing or shorter than 32 characters");
    this.name = "FeedSessionSecretError";
  }
}

export type RejectReason = "malformed" | "oversized" | "invalid" | "expired" | "page_size_mismatch" | "out_of_range";
export type ReadResult =
  | { ok: true; page: number; pageCount: number; pageSize: number; issuedAt: number; ids: string[] }
  | { ok: false; reason: RejectReason };

export interface OpenedSession {
  issuedAt: number;
  pageSize: number;
  pageCount: number;
  total: number;
  /** Page 1 ids, in order. */
  firstPage: string[];
  /** continuation[i] serves page i + 2. Empty when everything fits on page 1. */
  continuation: string[];
}

/** Canonical JSON: object keys sorted, arrays kept in the caller's order. */
export function canonicalBinding(binding: SessionBinding): string {
  const keys = Object.keys(binding).sort();
  return JSON.stringify(keys.map((k) => [k, binding[k] === undefined ? null : binding[k]]));
}

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function packIds(ids: readonly string[]): string {
  const out = new Uint8Array(ids.length * 16);
  ids.forEach((id, n) => {
    const hex = id.replace(/-/g, "");
    for (let i = 0; i < 16; i++) out[n * 16 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  });
  return b64url(out);
}

function unpackIds(s: string): string[] | null {
  const bytes = fromB64url(s);
  if (!bytes || bytes.length === 0 || bytes.length % 16 !== 0) return null;
  const ids: string[] = [];
  for (let n = 0; n < bytes.length; n += 16) {
    let hex = "";
    for (let i = 0; i < 16; i++) hex += bytes[n + i].toString(16).padStart(2, "0");
    ids.push(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
  }
  return ids;
}

export async function mac(secret: string, message: string): Promise<Uint8Array> {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) throw new FeedSessionSecretError();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Domain-separated: a feed-session MAC can never be confused with any other HMAC made from the same key.
const signedText = (body: string, binding: SessionBinding) => `${FEED_SESSION_VERSION}|feed-session|${body}|${canonicalBinding(binding)}`;

/**
 * Fixes a session from the final ordered list (ranked, filtered and company-capped exactly as page 1 shows it).
 * Throws on duplicate ids, non-UUID ids, more than MAX_MEMBERS ids, a bad page size or a missing secret: these are
 * caller bugs, never user input.
 */
export async function openFeedSession(opts: {
  orderedIds: readonly string[];
  binding: SessionBinding;
  secret: string;
  pageSize: number;
  now: number;
}): Promise<OpenedSession> {
  const { orderedIds, binding, secret, pageSize, now } = opts;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw new RangeError(`pageSize must be 1..${MAX_PAGE_SIZE}`);
  if (orderedIds.length > MAX_MEMBERS) throw new RangeError(`session holds at most ${MAX_MEMBERS} ids`);
  if (new Set(orderedIds).size !== orderedIds.length) throw new Error("session ids must be unique");
  if (!orderedIds.every((id) => UUID_REGEX.test(id))) throw new Error("session ids must be UUIDs");
  if (!Number.isInteger(now) || now <= 0) throw new RangeError("now must be epoch milliseconds");
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) throw new FeedSessionSecretError();

  const pageCount = Math.max(1, Math.ceil(orderedIds.length / pageSize));
  const continuation: string[] = [];
  for (let page = 2; page <= pageCount; page++) {
    const ids = orderedIds.slice((page - 1) * pageSize, page * pageSize);
    const body = `${now.toString(36)}.${page}.${pageCount}.${pageSize}.${packIds(ids)}`;
    continuation.push(`${FEED_SESSION_VERSION}.${body}.${b64url(await mac(secret, signedText(body, binding)))}`);
  }
  return { issuedAt: now, pageSize, pageCount, total: orderedIds.length, firstPage: orderedIds.slice(0, pageSize), continuation };
}

/** Verifies one continuation against the current request's binding and page size. Never throws on user input. */
export async function readFeedPage(opts: {
  token: unknown;
  binding: SessionBinding;
  secret: string;
  pageSize: number;
  now: number;
  ttlMs?: number;
}): Promise<ReadResult> {
  const { token, binding, secret, pageSize, now } = opts;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "malformed" };
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "oversized" };
  const parts = token.split(".");
  if (parts.length !== 7 || parts[0] !== FEED_SESSION_VERSION) return { ok: false, reason: "malformed" };
  const [, issued36, pageStr, countStr, sizeStr, packed, macStr] = parts;
  if (!/^[0-9a-z]{1,11}$/.test(issued36) || ![pageStr, countStr, sizeStr].every((s) => /^[1-9][0-9]{0,3}$/.test(s))) {
    return { ok: false, reason: "malformed" };
  }
  const issuedAt = parseInt(issued36, 36);
  const page = Number(pageStr);
  const pageCount = Number(countStr);
  const size = Number(sizeStr);
  const ids = unpackIds(packed);
  const sig = fromB64url(macStr);
  if (!ids || !sig || sig.length !== 32 || ids.length > size || size > MAX_PAGE_SIZE) return { ok: false, reason: "malformed" };

  const body = parts.slice(1, 6).join(".");
  if (!equalBytes(sig, await mac(secret, signedText(body, binding)))) return { ok: false, reason: "invalid" };
  // Checked only after the MAC: an attacker cannot learn which field a forged token got wrong.
  if (issuedAt > now + MAX_CLOCK_SKEW_MS || now - issuedAt > ttlMs) return { ok: false, reason: "expired" };
  if (size !== pageSize) return { ok: false, reason: "page_size_mismatch" };
  if (page < 2 || page > pageCount || pageCount > Math.ceil(MAX_MEMBERS / size)) return { ok: false, reason: "out_of_range" };
  if (page < pageCount && ids.length !== size) return { ok: false, reason: "malformed" };
  if (new Set(ids).size !== ids.length) return { ok: false, reason: "malformed" };
  return { ok: true, page, pageCount, pageSize: size, issuedAt, ids };
}

/**
 * Rows of one snapshot page, in snapshot order. `eligibleRows` must come from a query restricted to `ids` AND every
 * current eligibility filter (active, visible source, user exclusions, query filters): anything missing there is
 * inactive, hidden, deleted or no longer matching and is dropped; nothing outside `ids` is ever returned.
 */
export function orderSurvivors<T extends { id: string }>(ids: readonly string[], eligibleRows: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of eligibleRows) if (!byId.has(row.id)) byId.set(row.id, row);
  const out: T[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) out.push(row);
  }
  return out;
}
