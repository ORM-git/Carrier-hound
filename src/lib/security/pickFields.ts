/**
 * Global mass-assignment whitelist (Backend sheet rank 72).
 *
 * Every API write route in this repo already picks body fields explicitly
 * (a static guard in src/lib/__tests__/massAssignment.test.ts keeps that
 * true). This module is the shared mechanism for the cases where a route
 * legitimately accepts a free-form object: it copies ONLY allowlisted
 * own-enumerable keys, always drops prototype-polluting keys, and can
 * strip server-owned fields a client must never set.
 */

/** Keys that must never be copied from a client-supplied object. */
export const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Server-owned fields that clients must never write, even if allowlisted
 *  by mistake. Keep aligned with docs/data-classification.md. */
export const SERVER_OWNED_FIELDS = new Set([
  "id",
  "user_id",
  "role",
  "is_admin",
  "is_blocked",
  "plan",
  "email_confirmed_at",
  "created_at",
  "updated_at",
]);

export interface PickResult {
  /** The safe object to pass onward. */
  picked: Record<string, unknown>;
  /** Allowlisted-but-server-owned keys that were stripped (audit signal). */
  strippedServerOwned: string[];
}

/**
 * Returns a plain object containing only `allowed` keys from `input`,
 * minus prototype keys and server-owned fields. Non-object input yields
 * an empty object.
 */
export function pickAllowed(
  input: unknown,
  allowed: readonly string[],
  options: { keepServerOwned?: boolean } = {}
): PickResult {
  const picked: Record<string, unknown> = {};
  const strippedServerOwned: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { picked, strippedServerOwned };
  }
  for (const key of allowed) {
    if (PROTOTYPE_KEYS.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    if (!options.keepServerOwned && SERVER_OWNED_FIELDS.has(key)) {
      strippedServerOwned.push(key);
      continue;
    }
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    picked[key] = value;
  }
  return { picked, strippedServerOwned };
}
