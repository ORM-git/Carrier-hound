/**
 * src/lib/ai/circuitBreaker.ts
 *
 * Circuit breaker for upstream Groq API calls.
 *
 * Rules:
 * 1. Tracks consecutive failures and timeouts within a sliding 60s window.
 * 2. After 5 consecutive failures/timeouts within 60s, trips to OPEN state.
 * 3. While OPEN, fails fast for 30s with clean 503 "AI temporarily busy".
 * 4. While OPEN, requests must NOT consume concurrency leases, global budget reservations, or user quota.
 * 5. After 30s in OPEN state, transitions to HALF_OPEN and allows exactly one probe request.
 * 6. If the probe request succeeds, resets to CLOSED state and clears failure counts.
 * 7. If the probe request fails, re-opens for another 30s cooldown.
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  failureThreshold?: number; // default: 5
  failureWindowMs?: number;   // default: 60_000 (60s)
  cooldownMs?: number;        // default: 30_000 (30s)
}

export class GroqCircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failureTimestamps: number[] = [];
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  public readonly failureThreshold: number;
  public readonly failureWindowMs: number;
  public readonly cooldownMs: number;

  constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 5;
    this.failureWindowMs = config.failureWindowMs ?? 60_000;
    this.cooldownMs = config.cooldownMs ?? 30_000;
  }

  /**
   * Returns the current state, dynamically evaluating if an OPEN circuit has entered HALF_OPEN.
   */
  getState(now = Date.now()): CircuitState {
    if (this.state === "OPEN" && now - this.openedAt >= this.cooldownMs) {
      return "HALF_OPEN";
    }
    return this.state;
  }

  /**
   * Checks whether a request can execute.
   * If in HALF_OPEN, allows only one probe request while setting probeInFlight.
   */
  canExecute(now = Date.now()): { allowed: boolean; isProbe?: boolean; state: CircuitState } {
    const currentState = this.getState(now);

    if (currentState === "CLOSED") {
      return { allowed: true, state: "CLOSED" };
    }

    if (currentState === "OPEN") {
      return { allowed: false, state: "OPEN" };
    }

    if (currentState === "HALF_OPEN") {
      this.state = "HALF_OPEN";
      if (!this.probeInFlight) {
        this.probeInFlight = true;
        return { allowed: true, isProbe: true, state: "HALF_OPEN" };
      }
      return { allowed: false, state: "HALF_OPEN" };
    }

    return { allowed: false, state: this.state };
  }

  /**
   * Records a successful upstream Groq call.
   * Transitions circuit back to CLOSED and resets consecutive failure counters.
   */
  recordSuccess(): void {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.failureTimestamps = [];
    this.probeInFlight = false;
    this.openedAt = 0;
  }

  /**
   * Records an upstream Groq failure or timeout.
   */
  recordFailure(now = Date.now()): void {
    const currentState = this.getState(now);

    if (currentState === "HALF_OPEN") {
      // Probe request failed: re-open circuit for cooldownMs
      this.state = "OPEN";
      this.openedAt = now;
      this.probeInFlight = false;
      this.consecutiveFailures++;
      this.failureTimestamps.push(now);
      return;
    }

    // Prune failure timestamps outside the sliding failureWindowMs (60s)
    this.failureTimestamps = this.failureTimestamps.filter((t) => now - t <= this.failureWindowMs);
    this.failureTimestamps.push(now);
    this.consecutiveFailures++;

    if (
      this.consecutiveFailures >= this.failureThreshold &&
      this.failureTimestamps.length >= this.failureThreshold
    ) {
      this.state = "OPEN";
      this.openedAt = now;
      this.probeInFlight = false;
    }
  }

  /**
   * Releases the probe lock if the probe request was rejected before Groq was called (e.g. quota check).
   */
  releaseProbe(): void {
    if (this.state === "HALF_OPEN") {
      this.probeInFlight = false;
    }
  }

  /**
   * Resets the circuit breaker to clean initial state.
   */
  reset(): void {
    this.state = "CLOSED";
    this.failureTimestamps = [];
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getOpenedAt(): number {
    return this.openedAt;
  }

  isProbeInFlight(): boolean {
    return this.probeInFlight;
  }
}

// Global shared circuit breaker instance
export const groqCircuitBreaker = new GroqCircuitBreaker();

export function _resetGroqCircuitBreaker(): void {
  groqCircuitBreaker.reset();
}
