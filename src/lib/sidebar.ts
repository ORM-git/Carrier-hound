"use client";

import { useState, useEffect } from "react";
import { readVersioned, writeVersioned } from "./storage/versioned";

export const SIDEBAR_STORAGE_KEY = "careermonke_sidebar_expanded";
/** Schema version of the stored sidebar payload (v0 was the legacy raw "true"/"false" string). */
export const SIDEBAR_STORAGE_VERSION = 1;
export const SIDEBAR_EVENT_KEY = "careermonke_sidebar_mode_changed";

/**
 * Reads the persisted desktop sidebar mode from localStorage.
 * Defaults to false (72px narrow icon rail).
 */
export function getStoredSidebarExpanded(): boolean {
  return readVersioned<boolean>(SIDEBAR_STORAGE_KEY, {
    version: SIDEBAR_STORAGE_VERSION,
    fallback: false,
    migrate: (from, raw) => (from === 0 ? raw === true || raw === "true" : raw),
    validate: (d): d is boolean => typeof d === "boolean",
  });
}

/**
 * Persists the desktop sidebar mode to localStorage and notifies listeners.
 */
export function setStoredSidebarExpanded(expanded: boolean): void {
  if (typeof window === "undefined") return;
  try {
    writeVersioned(SIDEBAR_STORAGE_KEY, SIDEBAR_STORAGE_VERSION, expanded);
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
