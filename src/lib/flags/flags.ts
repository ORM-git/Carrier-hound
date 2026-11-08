/**
 * Feature flag registry (Backend sheet row 48).
 *
 * One list of every env-driven flag the code reads today, with the exact rule each
 * one uses and its default. Every default is "off", which is today's behavior.
 * Nothing here changes how any existing call site reads its flag: call sites keep
 * their own `process.env.NAME === "true"` checks (NEXT_PUBLIC_ names must stay literal
 * so the build can inline them). `isFlagEnabled` gives server code and tests one
 * place that applies the same rule, and `scripts/test-flags-registry.ts` fails if a
 * new `process.env.X === "true"` flag appears in src/ or netlify/ without an entry.
 *
 * Not a flag service: no per-user or percentage rollout, no runtime changes, no
 * dashboard. Changing a flag means changing the host environment and redeploying.
 */

/** "strict_true": only the exact string "true" turns it on (as the call sites do). */
/** "truthy_words": true, 1, yes or on, case-insensitive after trim (AI_GLOBAL_DISABLE). */
export type FlagRule = "strict_true" | "truthy_words";

export interface FlagDefinition {
  envVar: string;
  rule: FlagRule;
  /** Value when the variable is unset. Always false today. */
  defaultEnabled: false;
  /** Where the flag is read. Public flags are inlined at build time. */
  scope: "server" | "public-build";
  description: string;
}

export const FLAGS: readonly FlagDefinition[] = [
  { envVar: "NEXT_PUBLIC_BILLING_ENABLED", rule: "strict_true", defaultEnabled: false, scope: "public-build",
    description: "Payments. Stays off until the owner activates billing." },
  { envVar: "NEXT_PUBLIC_ENABLE_INTERVIEW_PACK", rule: "strict_true", defaultEnabled: false, scope: "public-build",
    description: "Shows the interview pack entry on job detail." },
  { envVar: "NEXT_PUBLIC_ENABLE_SKILL_WHAT_IF", rule: "strict_true", defaultEnabled: false, scope: "public-build",
    description: "Shows the skill what-if entry on job detail." },
  { envVar: "ALLOW_LOCALHOST_CORS", rule: "strict_true", defaultEnabled: false, scope: "server",
    description: "Allows localhost origins in the Netlify functions CORS list outside development." },
  { envVar: "AI_GLOBAL_DISABLE", rule: "truthy_words", defaultEnabled: false, scope: "server",
    description: "Emergency kill switch for AI routes." },
  { envVar: "__CAREERMONKE_LEGACY_CAP_FAIL_OPEN", rule: "strict_true", defaultEnabled: false, scope: "server",
    description: "Restores the earlier fail-open behavior in the early-access mailer cap." },
  { envVar: "__CAREERMONKE_LEGACY_DIGEST_SEND_EMPTY", rule: "strict_true", defaultEnabled: false, scope: "server",
    description: "Restores the earlier behavior of sending an empty digest." },
  { envVar: "__CAREERMONKE_LEGACY_EARLY_ACCESS", rule: "strict_true", defaultEnabled: false, scope: "server",
    description: "Restores the earlier early-access behavior." },
  { envVar: "__CAREERMONKE_LEGACY_EARLY_ACCESS_UNLOCK", rule: "strict_true", defaultEnabled: false, scope: "server",
    description: "Restores the earlier early-access unlock in middleware." },
  { envVar: "__CAREERMONKE_LEGACY_JOBS_SERVICE", rule: "strict_true", defaultEnabled: false, scope: "server",
    description: "Restores the earlier jobs service behavior." },
  { envVar: "__CAREERMONKE_LEGACY_RATE_LIMIT", rule: "strict_true", defaultEnabled: false, scope: "server",
    description: "Restores the earlier rate limit behavior on search and track." },
];

export function getFlagDefinition(envVar: string): FlagDefinition | undefined {
  return FLAGS.find((f) => f.envVar === envVar);
}

/**
 * Applies the registered rule to the given env. Unknown names throw, so a typo
 * cannot silently read as "off".
 */
export function isFlagEnabled(envVar: string, env: Record<string, string | undefined>): boolean {
  const def = getFlagDefinition(envVar);
  if (!def) throw new Error(`Unknown feature flag: ${envVar}`);
  const raw = env[envVar];
  if (typeof raw !== "string") return def.defaultEnabled;
  if (def.rule === "strict_true") return raw === "true";
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}
