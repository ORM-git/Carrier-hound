const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN;

if (SENTRY_DSN && typeof window !== "undefined") {
  let initialized = false;
  const initSentry = () => {
    if (initialized) return;
    initialized = true;
    window.removeEventListener("pointerdown", initSentry);
    window.removeEventListener("keydown", initSentry);
    import("@sentry/nextjs").then((Sentry) => {
      if (typeof Sentry.getClient === "function" && Sentry.getClient()) return;
      Sentry.init({
        dsn: SENTRY_DSN,
        enabled: true,
        tracesSampleRate: process.env.NODE_ENV === "production" ? 0.05 : 1.0,
        beforeSend(event) {
          if (event.user) {
            delete event.user.ip_address;
            delete event.user.email;
            delete event.user.username;
            delete event.user.id;
          }
          if (event.request?.headers) {
            delete event.request.headers["authorization"];
            delete event.request.headers["cookie"];
            delete event.request.headers["x-forwarded-for"];
            delete event.request.headers["cf-connecting-ip"];
          }
          if (event.breadcrumbs) {
            event.breadcrumbs = event.breadcrumbs.map((b) => {
              if (b.data && typeof b.data === "object") {
                for (const key of Object.keys(b.data)) {
                  if (/token|key|secret|password|auth|jwt/i.test(key)) {
                    b.data[key] = "[REDACTED]";
                  }
                }
              }
              return b;
            });
          }
          return event;
        },
      });
    }).catch(() => {});
  };

  window.addEventListener("pointerdown", initSentry, { once: true, passive: true });
  window.addEventListener("keydown", initSentry, { once: true, passive: true });
}
