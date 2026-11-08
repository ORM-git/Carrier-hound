"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Row 32 (focus management): move keyboard/AT focus to the page's main
 * landmark after a client-side route change. Without this, focus stays on a
 * now-unmounted link and screen-reader users land nowhere on navigation.
 *
 * Logic only, no visible change:
 * - Skips the initial page load (first render only arms the listener).
 * - Browsers can still apply a :focus-visible outline when programmatic
 *   focus follows keyboard interaction, so the landmark gets an inline
 *   outline:none for this scripted focus only (no stylesheet change, and
 *   the landmark was never focusable before, so no prior state changes).
 * - preventScroll: true avoids any scroll jump.
 * - tabindex=-1 is set on the landmark only (script-focusable, stays out of
 *   the tab order); page markup is untouched.
 */
export default function RouteFocusManager() {
  const pathname = usePathname();
  const isInitialLoad = useRef(true);

  useEffect(() => {
    if (isInitialLoad.current) {
      isInitialLoad.current = false;
      return;
    }
    const target =
      document.querySelector("main") ??
      document.getElementById("main-content");
    if (!target) return;
    if (!target.hasAttribute("tabindex")) {
      target.setAttribute("tabindex", "-1");
    }
    if (target instanceof HTMLElement) {
      // Suppress the default outline for this scripted focus only. Longhand
      // (not the shorthand) so jsdom and every browser serialize it as set.
      target.style.outlineStyle = "none";
    }
    target.focus({ preventScroll: true });
  }, [pathname]);

  return null;
}
