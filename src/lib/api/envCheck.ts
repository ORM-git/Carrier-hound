

import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "api/envCheck" } });
/**
 * Shared utility for verifying required server environment variables.
 * Consistent error responses and logging naming the missing variable (never values).
 */

export interface MissingEnvError {
  error: string;
  missingVariable: string;
}

/**
 * Validates that all required variables are present and non-empty.
 * Returns null if all are present, or a structured MissingEnvError naming the first absent variable.
 */
export function checkRequiredEnv(
  requiredMap: Record<string, string | undefined>,
  context: string
): MissingEnvError | null {
  for (const [name, val] of Object.entries(requiredMap)) {
    if (!val || !val.trim()) {
      log.error(`[${context}] Missing required environment variable: ${name}`);
      return {
        error: `Missing required environment variable: ${name}`,
        missingVariable: name,
      };
    }
  }
  return null;
}
