// LOCAL PREP ONLY (row 69). Read-scan: capture the filter calls a query builder receives WITHOUT changing them.
// teeQuery(target) forwards every builder call to `target` unchanged (same method, same arguments, same order) and
// returns target's own result, while a recorder (captureFilters.recorder) sees the identical call. So capturing a
// query can never change which rows its eligibility/search filters return: the live query is exactly what it would
// have been without capture. Proof here is fixture-level (fake builder + AST oracle), not a real PostgREST oracle.
import { recorder, type FilterNode } from "@/lib/jobs/captureFilters";

export type BuilderCall = { method: string; args: unknown[] };

/** Copies arguments for the call log so a later mutation by the caller cannot rewrite history. */
const snapshotArgs = (args: unknown[]): unknown[] => JSON.parse(JSON.stringify(args)) as unknown[];

export function teeQuery<T extends object>(target: T): { q: T; ast: () => FilterNode; calls: () => BuilderCall[] } {
  const rec = recorder();
  const calls: BuilderCall[] = [];
  let current: any = target;
  const q: any = new Proxy({}, {
    get: (_t, method: string) => (...args: unknown[]) => {
      calls.push({ method, args: snapshotArgs(args) });
      rec.q[method](...args);                 // throws on a method capture cannot represent: fail closed, before the live call
      current = current[method](...args);    // the live builder gets the identical call
      return q;
    },
  });
  return { q: q as T, ast: rec.ast, calls: () => calls.map((c) => ({ method: c.method, args: snapshotArgs(c.args) })) };
}

/** A minimal fake builder that only records the calls it receives (fixture for the read-scan proof). */
export function callLogBuilder(): { q: any; calls: () => BuilderCall[] } {
  const calls: BuilderCall[] = [];
  const q: any = new Proxy({}, { get: (_t, method: string) => (...args: unknown[]) => { calls.push({ method, args: snapshotArgs(args) }); return q; } });
  return { q, calls: () => calls };
}
