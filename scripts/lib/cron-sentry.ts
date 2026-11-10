/**
 * Cron failure visibility (Backend sheet rank 34).
 *
 * Scheduled scripts (GitHub Actions cron workflows) previously surfaced
 * failures only as GitHub failure emails. This helper reports fatal cron
 * errors to Sentry (via the existing server config: DSN-gated, PII-scrubbed,
 * off when no DSN) tagged with the cron name, then flushes so short-lived
 * script processes actually deliver the event before exiting.
 *
 * Fail-open by design: reporting must never change a cron's exit behavior.
 */

import "../../sentry.server.config";
import * as Sentry from "@sentry/nextjs";

export async function reportCronFailure(cronName: string, err: unknown): Promise<void> {
  try {
    Sentry.withScope((scope) => {
      scope.setTag("cron", cronName);
      Sentry.captureException(err);
    });
    await Sentry.flush(2000);
  } catch {
    // Never let monitoring break the cron's own exit path.
  }
}

export async function reportCronFailureMessage(
  cronName: string,
  message: string,
  extra?: Record<string, unknown>
): Promise<void> {
  try {
    Sentry.withScope((scope) => {
      scope.setTag("cron", cronName);
      if (extra) {
        scope.setExtras(extra);
      }
      Sentry.captureMessage(message, "error");
    });
    await Sentry.flush(2000);
  } catch {
    // Never let monitoring break the cron's own exit path.
  }
}
