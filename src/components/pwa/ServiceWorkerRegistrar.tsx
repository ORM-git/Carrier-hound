"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js in production only. The service worker caches immutable
 * build assets and serves /offline.html for navigations without a network;
 * it never caches API or Supabase traffic.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registration failures are non-fatal; the site works without a SW.
    });
  }, []);

  return null;
}
