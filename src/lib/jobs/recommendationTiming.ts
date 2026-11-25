import { createLogger } from "@/lib/observability/logger";

/** Wall durations, NOT CPU time. No URL, query, identity, profile or job content enters logs. */
export function recommendationTiming(ray: string | null, now = () => performance.now()) {
  const requestId = crypto.randomUUID();
  const cfRay = ray && /^[a-f0-9]{16,32}-[A-Z]{3}$/.test(ray) ? ray : undefined;
  const log = createLogger({ level: "info", context: { route: "/api/jobs/recommended", requestId, ...(cfRay ? { cfRay } : {}) } });
  const started = now();
  let stage = "setup";
  let stageStarted = started;
  const durations: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const elapsed = (from: number) => Math.round(Math.max(0, now() - from) * 100) / 100;
  function emit(event: string, status?: number) {
    try { log.info("recommended_request_timing", { event, stage, ...durations, ...counts, totalWallMs: elapsed(started), ...(status ? { status } : {}) }); }
    catch { /* Telemetry never changes the response. */ }
  }
  emit("start");
  return {
    requestId,
    begin(next: "db" | "scoring" | "format") {
      durations[`${stage}WallMs`] = elapsed(stageStarted);
      stage = next;
      stageStarted = now();
      emit("stage_start"); // Survives in logs even when the runtime kills the next stage.
    },
    rows(kind: "candidateRows" | "rankedRows" | "returnedRows", value: number) {
      counts[kind] = Number.isSafeInteger(value) && value >= 0 ? value : 0;
    },
    finish(status: number) {
      durations[`${stage}WallMs`] = elapsed(stageStarted);
      emit("finish", status);
    },
  };
}
