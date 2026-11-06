/** Server-side operation identities must be unpredictable across isolates.
 * No clock/Math.random fallback: Web Crypto is required by the edge runtime. */
export function createOperationId(prefix: "set" | "lease"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
