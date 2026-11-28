"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { savedFeedConstraintsEnforced } from "@/lib/preferences/feedConstraints";

/** A true answer is trusted for at most this long; focus and visibility changes refresh sooner. */
export const YEARS_CAPABILITY_TTL_MS = 5 * 60_000;
const FOCUS_REFRESH_MS = 60_000;
/** The capability request is abandoned (and aborted) after this long: no answer means not ready. */
export const YEARS_CAPABILITY_FETCH_DEADLINE_MS = 5_000;

/**
 * Shared, bounded-freshness readiness of the numeric required-years filter. true only when the server says it can
 * apply it (GET /api/jobs/capabilities: owner gate + service key + live column probe) AND this bundle's own public
 * gate is on (the request is only sent under that gate, so a server-only true would be silently dropped).
 * null = not yet known, false = unavailable or the check failed. refresh() always asks the server and fails closed.
 */
export function useRequiredYearsCapability(): { ready: boolean | null; checking: boolean; refresh: () => Promise<boolean> } {
  const [ready, setReady] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const token = useRef(0);
  const lastAt = useRef(0);
  const refresh = useCallback(async (): Promise<boolean> => {
    const mine = ++token.current;
    setChecking(true);
    let ok = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => ctl?.abort(), YEARS_CAPABILITY_FETCH_DEADLINE_MS);
    try {
      if (typeof fetch === "function") {
        deadlineTimer = undefined;
        const deadline = new Promise<never>((_, rej) => { deadlineTimer = setTimeout(() => rej(new Error("capability deadline")), YEARS_CAPABILITY_FETCH_DEADLINE_MS); });
        const read = (async () => {
          const r = await fetch("/api/jobs/capabilities", { cache: "no-store", ...(ctl ? { signal: ctl.signal } : {}) });
          return r.ok ? await r.json() : null;
        })();
        read.catch(() => {});
        const j = await Promise.race([read, deadline]);
        ok = j?.requiredYearsFilter === true && savedFeedConstraintsEnforced();
      }
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
    if (mine === token.current) {
      lastAt.current = Date.now();
      setReady(ok);
      setChecking(false);
    }
    // An answer that a newer check has superseded (or an unmounted hook) must not authorise anything.
    return mine === token.current && ok;
  }, []);
  useEffect(() => {
    void refresh();
    const stale = () => Date.now() - lastAt.current > FOCUS_REFRESH_MS;
    const onFocus = () => { if (stale()) void refresh(); };
    const onVisible = () => { if (typeof document !== "undefined" && document.visibilityState === "visible" && stale()) void refresh(); };
    const timer = setInterval(() => void refresh(), YEARS_CAPABILITY_TTL_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      token.current++;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
  return { ready, checking, refresh };
}
