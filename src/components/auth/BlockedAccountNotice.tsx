"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

export default function BlockedAccountNotice() {
  const [isBlocked, setIsBlocked] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const checkBlocked = () => {
      const notice = localStorage.getItem("careermonke_blocked_notice");
      if (notice === "true") {
        setIsBlocked(true);
      }
    };

    checkBlocked();
    window.addEventListener("careermonke_auth_updated", checkBlocked);
    return () => window.removeEventListener("careermonke_auth_updated", checkBlocked);
  }, []);

  if (!isBlocked) return null;

  const dismiss = () => {
    setIsBlocked(false);
    if (typeof window !== "undefined") {
      localStorage.removeItem("careermonke_blocked_notice");
    }
  };

  return (
    <div
      role="alert"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
    >
      <div className="bg-white rounded-xl max-w-md w-full p-6 shadow-2xl border border-red-200 relative text-left">
        <button
          onClick={dismiss}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition-colors"
          aria-label="Close notification"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center text-red-600 mb-4">
          <AlertTriangle className="w-6 h-6" />
        </div>

        <h3 className="text-xl font-bold text-gray-900 mb-2">Account Suspended</h3>
        <p className="text-sm text-gray-600 mb-4 leading-relaxed">
          Your CareerMonke account access has been suspended by an administrator. All active sessions have been immediately revoked.
        </p>
        <p className="text-xs text-gray-500 mb-6 bg-gray-50 p-3 rounded-lg border border-gray-100">
          If you believe this suspension is in error or require support, please contact{" "}
          <a
            href="mailto:support@careermonke.com"
            className="text-blue-600 font-semibold underline hover:text-blue-700"
          >
            support@careermonke.com
          </a>.
        </p>

        <button
          onClick={dismiss}
          className="w-full py-2.5 px-4 bg-gray-900 hover:bg-gray-800 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          Acknowledge & Sign Out
        </button>
      </div>
    </div>
  );
}
