"use client";

import React, { useEffect, useState } from "react";
import { Download } from "lucide-react";

/**
 * Subtle A2HS install affordance. Renders nothing until the browser fires
 * `beforeinstallprompt` (installable PWA criteria met), then shows a small
 * outline button. Hides permanently for the session once installed or used.
 * App pages only - never rendered on the landing page.
 */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export default function InstallAppButton() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => setDeferredPrompt(null);
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  if (!deferredPrompt) return null;

  const handleInstall = async () => {
    const promptEvent = deferredPrompt;
    setDeferredPrompt(null);
    try {
      await promptEvent.prompt();
      await promptEvent.userChoice;
    } catch {
      // Browser dismissed or errored; stay quiet, the button simply hides.
    }
  };

  return (
    <button
      type="button"
      onClick={handleInstall}
      className="inline-flex items-center gap-1.5 rounded-lg border border-[#DBE3EF] bg-white px-3 py-1.5 text-xs font-semibold text-[#2563EB] hover:bg-[#EFF6FF] transition-colors"
      aria-label="Install CareerMonke as an app"
    >
      <Download className="h-3.5 w-3.5" aria-hidden="true" />
      Install app
    </button>
  );
}
