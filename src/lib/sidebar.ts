"use client";

import { useState, useEffect } from "react";

export const SIDEBAR_STORAGE_KEY = "careermonke_sidebar_expanded";
export const SIDEBAR_EVENT_KEY = "careermonke_sidebar_mode_changed";

/**
 * Reads the persisted desktop sidebar mode from localStorage.
 * Defaults to false (72px narrow icon rail).
 */
export function getStoredSidebarExpanded(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Persists the desktop sidebar mode to localStorage and notifies listeners.
 */
export function setStoredSidebarExpanded(expanded: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(expanded));
    window.dispatchEvent(
      new CustomEvent(SIDEBAR_EVENT_KEY, { detail: { expanded } })
    );
  } catch {}
}

/**
 * React hook to synchronize sidebar mode across components and routes.
 */
export function useSidebarMode() {
  const [isExpanded, setIsExpanded] = useState<boolean>(false);

  useEffect(() => {
    setIsExpanded(getStoredSidebarExpanded());

    const handleModeChange = (e: Event) => {
      const custom = e as CustomEvent<{ expanded: boolean }>;
      if (custom.detail && typeof custom.detail.expanded === "boolean") {
        setIsExpanded(custom.detail.expanded);
      } else {
        setIsExpanded(getStoredSidebarExpanded());
      }
    };

    window.addEventListener(SIDEBAR_EVENT_KEY, handleModeChange);
    window.addEventListener("storage", handleModeChange);

    return () => {
      window.removeEventListener(SIDEBAR_EVENT_KEY, handleModeChange);
      window.removeEventListener("storage", handleModeChange);
    };
  }, []);

  const toggle = () => {
    const next = !isExpanded;
    setIsExpanded(next);
    setStoredSidebarExpanded(next);
  };

  return { isExpanded, toggle, setIsExpanded };
}
