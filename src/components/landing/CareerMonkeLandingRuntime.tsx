"use client";

import { useEffect } from "react";
import { initCareerMonkeLanding } from "./careermonke-landing-runtime";

export default function CareerMonkeLandingRuntime() {
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;

    const runInit = () => {
      if (cancelled || cleanup) return;
      cleanup = initCareerMonkeLanding();
    };

    const onUserAction = () => {
      window.removeEventListener("pointerdown", onUserAction);
      window.removeEventListener("keydown", onUserAction);
      window.removeEventListener("scroll", onUserAction);
      runInit();
    };
    window.addEventListener("pointerdown", onUserAction, { once: true, passive: true });
    window.addEventListener("keydown", onUserAction, { once: true, passive: true });
    window.addEventListener("scroll", onUserAction, { once: true, passive: true });

    if (document.readyState === "complete") {
      if ("requestIdleCallback" in window) {
        const handle = (window as any).requestIdleCallback(runInit);
        return () => {
          cancelled = true;
          window.removeEventListener("pointerdown", onUserAction);
          window.removeEventListener("keydown", onUserAction);
          window.removeEventListener("scroll", onUserAction);
          if ("cancelIdleCallback" in window) (window as any).cancelIdleCallback(handle);
          cleanup?.();
        };
      } else {
        const handle = setTimeout(runInit, 1000);
        return () => {
          cancelled = true;
          window.removeEventListener("pointerdown", onUserAction);
          window.removeEventListener("keydown", onUserAction);
          window.removeEventListener("scroll", onUserAction);
          clearTimeout(handle);
          cleanup?.();
        };
      }
    } else {
      const onLoad = () => {
        window.removeEventListener("load", onLoad);
        if ("requestIdleCallback" in window) {
          (window as any).requestIdleCallback(runInit);
        } else {
          setTimeout(runInit, 1000);
        }
      };
      window.addEventListener("load", onLoad, { once: true });
      return () => {
        cancelled = true;
        window.removeEventListener("pointerdown", onUserAction);
        window.removeEventListener("keydown", onUserAction);
        window.removeEventListener("scroll", onUserAction);
        window.removeEventListener("load", onLoad);
        cleanup?.();
      };
    }
  }, []);

  return null;
}
