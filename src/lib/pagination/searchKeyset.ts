/**
 * Keyset continuation for job search over its FULL sort key (row 69).
 *
 * The old search cursor holds (posted_at, id) only, while sort=match orders by verified first, so the page after the
 * last verified job skips unverified jobs newer than that job (see the negative control in the tests). This module
 * defines one total order per sort, a cursor that carries every key of it, and the PostgREST filter that selects
 * exactly the rows after the cursor:
 *   newest: posted_at DESC NULLS LAST, id DESC
 *   match:  verified DESC NULLS LAST (true > false > null), posted_at DESC NULLS LAST, id DESC
 * Every page of a session is also bounded to rows whose first_seen_at <= the session's arrival time (first_seen_at is
 * insert-only in this repo's writers), so jobs inserted after page 1 enter only on refresh or a new query.
 *
 * Guarantee (stated, and tested against real Postgres in PGlite): for rows whose sort keys do not change during the
 * session, pages concatenate to exactly the rows that existed at the arrival time and still match, in order, with no
 * repeat and no skip. A row whose verified/posted_at changes mid-session can move across the cursor (one skip or one
 * repeat; the client's appendPage hides repeats). Search is unbounded, so its membership is not snapshotted.
 *
 * Cursors are signed and bound like feed-session continuations (same secret, separate domain).
 */

import { UUID_REGEX, POSTED_AT_REGEX } from "./cursor";
import { b64url, canonicalBinding, DEFAULT_TTL_MS, equalBytes, fromB64url, mac, MAX_CLOCK_SKEW_MS, type SessionBinding } from "./feedSession";

export type SearchSort = "newest" | "match";
export const SEARCH_KEYSET_VERSION = "ks1";
const MAX_CURSOR_LENGTH = 400;

export interface SortKey {
  verified: boolean | null;
  posted_at: string | null;
  id: string;
}
export interface SearchCursor extends SortKey {
  /** Session arrival bound (epoch ms): only rows with first_seen_at <= this are listed. */
  arrivalAt: number;
}
export type KeysetReject = "malformed" | "oversized" | "invalid" | "expired";

/** Order for PostgREST `.order()` calls, in sequence. Every key is NULLS LAST, so the order is total with id. */
export function searchOrder(sort: SearchSort): Array<{ column: "verified" | "posted_at" | "id"; ascending: false; nullsFirst: false }> {
  const keys = sort === "match" ? (["verified", "posted_at", "id"] as const) : (["posted_at", "id"] as const);
  return keys.map((column) => ({ column, ascending: false, nullsFirst: false }));
}

const q = (v: string) => `"${v}"`; // values are validated ISO timestamps / UUIDs, quoted for the PostgREST grammar

function afterPosted(c: SortKey): string {
  return c.posted_at !== null
    ? `posted_at.lt.${q(c.posted_at)},and(posted_at.eq.${q(c.posted_at)},id.lt.${q(c.id)}),posted_at.is.null`
    : `and(posted_at.is.null,id.lt.${q(c.id)})`;
}

/** PostgREST `.or()` argument selecting exactly the rows strictly after `c` in searchOrder(sort). */
export function afterCursorFilter(c: SortKey, sort: SearchSort): string {
  if (sort === "newest") return afterPosted(c);
  const same = (v: string) => `and(verified.${v},or(${afterPosted(c)}))`;
  if (c.verified === true) return `verified.eq.false,verified.is.null,${same("eq.true")}`;
  if (c.verified === false) return `verified.is.null,${same("eq.false")}`;
  return same("is.null");
}

/** Reference comparator for searchOrder(sort) (negative = a first). Used by tests and in-memory callers. */
export function compareSortKeys(a: SortKey, b: SortKey, sort: SearchSort): number {
  if (sort === "match") {
    const rank = (v: boolean | null) => (v === true ? 0 : v === false ? 1 : 2);
    if (rank(a.verified) !== rank(b.verified)) return rank(a.verified) - rank(b.verified);
  }
  if (a.posted_at !== b.posted_at) {
    if (a.posted_at === null) return 1;
    if (b.posted_at === null) return -1;
    const d = Date.parse(b.posted_at) - Date.parse(a.posted_at);
    if (d !== 0) return d;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

const signed = (body: string, binding: SessionBinding) => `${SEARCH_KEYSET_VERSION}|search-keyset|${body}|${canonicalBinding(binding)}`;
const enc = new TextEncoder();

/** Cursor for the page after `last`. `verified` must be the row's stored value (null kept as null). */
export async function encodeSearchCursor(last: SortKey, arrivalAt: number, binding: SessionBinding, secret: string): Promise<string> {
  if (!UUID_REGEX.test(last.id)) throw new Error("cursor id must be a UUID");
  if (last.posted_at !== null && !POSTED_AT_REGEX.test(last.posted_at)) throw new Error("cursor posted_at must be ISO 8601");
  const v = last.verified === true ? "t" : last.verified === false ? "f" : "n";
  const body = `${arrivalAt.toString(36)}.${v}.${last.posted_at === null ? "" : b64url(enc.encode(last.posted_at))}.${last.id}`;
  return `${SEARCH_KEYSET_VERSION}.${body}.${b64url(await mac(secret, signed(body, binding)))}`;
}

export async function decodeSearchCursor(opts: {
  token: unknown;
  binding: SessionBinding;
  secret: string;
  now: number;
  ttlMs?: number;
}): Promise<{ ok: true; cursor: SearchCursor } | { ok: false; reason: KeysetReject }> {
  const { token, binding, secret, now } = opts;
  if (typeof token !== "string" || !token) return { ok: false, reason: "malformed" };
  if (token.length > MAX_CURSOR_LENGTH) return { ok: false, reason: "oversized" };
  const parts = token.split(".");
  if (parts.length !== 6 || parts[0] !== SEARCH_KEYSET_VERSION) return { ok: false, reason: "malformed" };
  const [, a36, v, p64, id, macStr] = parts;
  const postedBytes = p64 === "" ? null : fromB64url(p64);
  const posted_at = postedBytes ? new TextDecoder().decode(postedBytes) : null;
  const sig = fromB64url(macStr);
  if (!/^[0-9a-z]{1,11}$/.test(a36) || !["t", "f", "n"].includes(v) || !UUID_REGEX.test(id) || !sig || sig.length !== 32
    || (p64 !== "" && (posted_at === null || !POSTED_AT_REGEX.test(posted_at)))) {
    return { ok: false, reason: "malformed" };
  }
  if (!equalBytes(sig, await mac(secret, signed(parts.slice(1, 5).join("."), binding)))) return { ok: false, reason: "invalid" };
  const arrivalAt = parseInt(a36, 36);
  if (arrivalAt > now + MAX_CLOCK_SKEW_MS || now - arrivalAt > (opts.ttlMs ?? DEFAULT_TTL_MS)) return { ok: false, reason: "expired" };
  return { ok: true, cursor: { verified: v === "t" ? true : v === "f" ? false : null, posted_at, id, arrivalAt } };
}
