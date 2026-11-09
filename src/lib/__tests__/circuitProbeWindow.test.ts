import { describe, expect, it } from "vitest";
import { GroqCircuitBreaker } from "../ai/circuitBreaker";

// Inspect retained state without adding a production diagnostics API.
const retained = (breaker: GroqCircuitBreaker) =>
  (breaker as unknown as { failureTimestamps: number[] }).failureTimestamps;

describe("circuit failed-probe window", () => {
  it("prunes stale timestamps throughout a long outage and still reopens each failed probe", () => {
    const breaker = new GroqCircuitBreaker({ failureThreshold: 2, failureWindowMs: 60, cooldownMs: 30 });
    breaker.recordFailure(0); breaker.recordFailure(1);
    for (let cycle = 1; cycle <= 1000; cycle++) {
      const now = 1 + cycle * 30;
      expect(breaker.canExecute(now)).toMatchObject({ allowed: true, isProbe: true });
      expect(breaker.canExecute(now).allowed).toBe(false);
      breaker.recordFailure(now);
      expect(breaker.getState(now)).toBe("OPEN");
      expect(breaker.getOpenedAt()).toBe(now);
      expect(breaker.isProbeInFlight()).toBe(false);
      expect(retained(breaker).every((t) => now - t <= 60)).toBe(true);
      expect(retained(breaker).length).toBeLessThanOrEqual(3);
    }
    expect(breaker.getConsecutiveFailures()).toBe(1002);
  });
  it("preserves timestamps on the window boundary and removes older ones", () => {
    const breaker = new GroqCircuitBreaker({ failureThreshold: 1, failureWindowMs: 60, cooldownMs: 30 });
    breaker.recordFailure(0);
    breaker.canExecute(30); breaker.recordFailure(30);
    breaker.canExecute(60); breaker.recordFailure(60);
    expect(retained(breaker)).toEqual([0, 30, 60]);
    breaker.canExecute(90); breaker.recordFailure(90);
    expect(retained(breaker)).toEqual([30, 60, 90]);
  });
  it("resets retained failures and returns to closed after successful probe", () => {
    const breaker = new GroqCircuitBreaker({ failureThreshold: 1, cooldownMs: 10 });
    breaker.recordFailure(0); breaker.canExecute(10); breaker.recordFailure(10);
    breaker.canExecute(20); breaker.recordSuccess();
    expect(breaker.getState(20)).toBe("CLOSED");
    expect(retained(breaker)).toEqual([]);
    expect(breaker.getConsecutiveFailures()).toBe(0);
    expect(breaker.isProbeInFlight()).toBe(false);
  });
});
