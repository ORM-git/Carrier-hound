"use client";

import { useEffect, useState } from "react";

// Each present sheet owns one lease. A closing sheet cannot unlock a newer one.
const bodyLocks = new WeakMap<HTMLElement, { count: number; previous: string }>();
function lockBody(body: HTMLElement) {
  const lock = bodyLocks.get(body) || { count: 0, previous: body.style.overflow };
  lock.count += 1;
  bodyLocks.set(body, lock);
  body.style.overflow = "hidden";
  return () => {
    lock.count -= 1;
    if (lock.count === 0) {
      body.style.overflow = lock.previous;
      bodyLocks.delete(body);
    }
  };
}

/** Keep a closing sheet mounted until its CSS exit finishes. No animation for reduced motion. */
export function useSheetPresence(isOpen: boolean) {
  const [present, setPresent] = useState(isOpen);
  useEffect(() => {
    if (isOpen) { setPresent(true); return; }
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => setPresent(false), reduced ? 0 : 300);
    return () => window.clearTimeout(timer);
  }, [isOpen]);
  useEffect(() => {
    if (!present) return;
    return lockBody(document.body);
  }, [present]);
  return { present: isOpen || present, exiting: !isOpen };
}
