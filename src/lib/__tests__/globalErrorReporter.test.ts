// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const captureException = vi.fn();

vi.mock("@/lib/monitoring/sentryErrorReporter", () => ({
  reportErrorToSentry: (error: unknown) => captureException(error),
}));

import { reportClientError } from "@/components/monitoring/GlobalErrorReporter";

describe("GlobalErrorReporter dedupe", () => {
  beforeEach(() => captureException.mockClear());

  it("reports a new error once", () => {
    reportClientError(new Error("hydration mismatch: text did not match"), 1000);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("dedupes the same error inside the window and reports again after it", () => {
    const err = new Error("Minified React error #418");
    reportClientError(err, 2000);
    reportClientError(err, 3000);
    expect(captureException).toHaveBeenCalledTimes(1);
    reportClientError(err, 20000);
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it("tracks distinct errors independently", () => {
    reportClientError(new Error("a"), 100);
    reportClientError(new Error("b"), 200);
    expect(captureException).toHaveBeenCalledTimes(2);
  });
});
