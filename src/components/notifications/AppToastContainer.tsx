"use client";

import React, { useEffect, useState } from "react";
import type { ToastContainerProps } from "react-toastify";

let ToastComponent: React.ComponentType<ToastContainerProps> | null = null;

export default function AppToastContainer(props: ToastContainerProps) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    function loadToast() {
      if (ToastComponent) {
        setReady(true);
        return;
      }
      Promise.all([
        import("react-toastify" as any),
      ]).then(([mod]) => {
        ToastComponent = mod.ToastContainer;
        setReady(true);
      }).catch(() => {});
    }

    if (window.location.pathname !== "/") {
      loadToast();
      return;
    }

    const onAction = () => {
      window.removeEventListener("pointerdown", onAction);
      window.removeEventListener("keydown", onAction);
      loadToast();
    };
    window.addEventListener("pointerdown", onAction, { once: true, passive: true });
    window.addEventListener("keydown", onAction, { once: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", onAction);
      window.removeEventListener("keydown", onAction);
    };
  }, []);

  if (!ready || !ToastComponent) return null;
  const Comp = ToastComponent;
  return <Comp {...props} />;
}
