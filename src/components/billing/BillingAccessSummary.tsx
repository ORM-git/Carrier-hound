import React from "react";

/** Access status is not a payment receipt. Subscription amounts can be grants,
 * zero-value QA records, or catalog fallbacks, so never label them as paid prices. */
export default function BillingAccessSummary({ isPro }: { isPro: boolean }) {
  return <p className="text-xs text-slate-500" data-testid="billing-access-summary">
    {isPro
      ? "Pro access is active. Payment amounts and confirmation status are shown in Payment history."
      : "Standard title browsing, 5 tracker slots, 1 ATS resume export."}
  </p>;
}
