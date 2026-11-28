// LOCAL PREP ONLY (row 69). Read-scan: capture the filter calls a query builder receives WITHOUT changing them.
// teeQuery(target) forwards every builder call to `target` unchanged (same method, same arguments, same order) and keeps
// the live builder's own chain. Awaiting the tee (or calling run()) awaits THAT live chain, so the caller gets exactly
// the rows the untouched query returns, while a recorder (captureFilters.recorder) sees the identical calls.
// "then" and symbol properties are never treated as builder calls (an awaited proxy used to throw on "then").
// Execution is MEMOIZED: the first await or run() executes the live builder once, and every later await/run() shares
// that one result (a plain Supabase builder would re-execute on each await). Adding a builder call after execution
// started throws, so a stale memo can never be returned for a changed query.
// Proof is fixture-level (fake builders + AST oracle), not a real PostgREST oracle.
import { recorder, type FilterNode } from "@/lib/jobs/captureFilters";

export type BuilderCall = { method: string; args: unknown[] };

/** Copies arguments for the call log so a later mutation by the caller cannot rewrite history. */
const snapshotArgs = (args: unknown[]): unknown[] => JSON.parse(JSON.stringify(args)) as unknown[];

export interface Tee<T> {
  /** Use like the original builder: filter calls are forwarded; `await q` resolves to the live builder's result. */
  q: T;
  /** Await the live builder chain (same value `await q` gives); executes it at most once. */
  run: () => Promise<unknown>;
  ast: () => FilterNode;
  calls: () => BuilderCall[];
}

export function teeQuery<T extends object>(target: T): Tee<T> {
  const rec = recorder();
  const calls: BuilderCall[] = [];
  let current: any = target;
  let execution: Promise<unknown> | null = null;
  const run = () => (execution ??= Promise.resolve(current));   // a thenable live builder is awaited here, once
  const q: any = new Proxy({}, {
    get: (_t, prop) => {
      if (typeof prop === "symbol") return undefined;
      if (prop === "then") {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => run().then(onFulfilled, onRejected);
      }
      if (prop === "catch" || prop === "finally") return (...a: any[]) => (run() as any)[prop](...a);
      const method = prop;
      return (...args: unknown[]) => {
        if (execution) throw new Error("query already executed; build a new query instead of extending this one");
        calls.push({ method, args: snapshotArgs(args) });
        (rec.q as any)[method](...args);      // throws on a method capture cannot represent: fail closed, before the live call
        current = current[method](...args);  // the live builder gets the identical call
        return q;
      };
    },
  });
  return { q: q as T, run, ast: rec.ast, calls: () => calls.map((c) => ({ method: c.method, args: snapshotArgs(c.args) })) };
}

/** A minimal fake builder that only records the calls it receives (fixture for the read-scan proof). Not awaitable. */
export function callLogBuilder(): { q: any; calls: () => BuilderCall[] } {
  const calls: BuilderCall[] = [];
  const q: any = new Proxy({}, {
    get: (_t, prop) => (typeof prop === "symbol" || prop === "then" ? undefined
      : (...args: unknown[]) => { calls.push({ method: prop, args: snapshotArgs(args) }); return q; }),
  });
  return { q, calls: () => calls };
}
