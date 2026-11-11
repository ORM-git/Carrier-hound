import { describe, it, expect } from "vitest";
import {
  createErrorResponse,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  rateLimited,
  internalError,
  serviceUnavailable,
} from "../errorResponse";

describe("createErrorResponse - Status Code Validation", () => {
  it("rejects non-integer status codes", () => {
    expect(() => createErrorResponse(404.5, "Not found")).toThrow(TypeError);
    expect(() => createErrorResponse(NaN, "Not found")).toThrow(TypeError);
    expect(() => createErrorResponse(Infinity, "Not found")).toThrow(TypeError);
  });

  it("rejects status codes below 400", () => {
    expect(() => createErrorResponse(200, "OK")).toThrow(TypeError);
    expect(() => createErrorResponse(201, "Created")).toThrow(TypeError);
    expect(() => createErrorResponse(301, "Moved")).toThrow(TypeError);
    expect(() => createErrorResponse(399, "Lower bound")).toThrow(TypeError);
    expect(() => createErrorResponse(0, "Zero")).toThrow(TypeError);
    expect(() => createErrorResponse(-500, "Negative")).toThrow(TypeError);
  });

  it("rejects status codes above 599", () => {
    expect(() => createErrorResponse(600, "Upper bound")).toThrow(TypeError);
    expect(() => createErrorResponse(700, "Custom status")).toThrow(TypeError);
    expect(() => createErrorResponse(999, "Out of range")).toThrow(TypeError);
  });

  it("accepts valid 4xx and 5xx error status codes", () => {
    const res400 = createErrorResponse(400, "Bad Request");
    expect(res400.status).toBe(400);

    const res404 = createErrorResponse(404, "Not Found");
    expect(res404.status).toBe(404);

    const res429 = createErrorResponse(429, "Rate Limited");
    expect(res429.status).toBe(429);

    const res500 = createErrorResponse(500, "Internal Error");
    expect(res500.status).toBe(500);

    const res503 = createErrorResponse(503, "Unavailable");
    expect(res503.status).toBe(503);

    const res599 = createErrorResponse(599, "Network Timeout");
    expect(res599.status).toBe(599);
  });
});

describe("createErrorResponse - Error Message Validation", () => {
  it("rejects non-string error messages", () => {
    expect(() => createErrorResponse(400, null as unknown as string)).toThrow(TypeError);
    expect(() => createErrorResponse(400, undefined as unknown as string)).toThrow(TypeError);
    expect(() => createErrorResponse(400, 123 as unknown as string)).toThrow(TypeError);
    expect(() => createErrorResponse(400, {} as unknown as string)).toThrow(TypeError);
    expect(() => createErrorResponse(400, [] as unknown as string)).toThrow(TypeError);
  });

  it("rejects empty or whitespace-only error messages", () => {
    expect(() => createErrorResponse(400, "")).toThrow(TypeError);
    expect(() => createErrorResponse(400, "   ")).toThrow(TypeError);
    expect(() => createErrorResponse(400, "\t\n")).toThrow(TypeError);
  });

  it("trims whitespace from valid error messages", async () => {
    const res = createErrorResponse(400, "  Invalid parameter provided  ");
    const json = await res.json();
    expect(json.error).toBe("Invalid parameter provided");
  });
});

describe("createErrorResponse - Options Validation", () => {
  it("rejects ok when it is truthy or anything other than false", () => {
    expect(() => createErrorResponse(400, "Bad Request", { ok: true as unknown as false })).toThrow(TypeError);
    expect(() => createErrorResponse(400, "Bad Request", { ok: "false" as unknown as false })).toThrow(TypeError);
    expect(() => createErrorResponse(400, "Bad Request", { ok: 1 as unknown as false })).toThrow(TypeError);
  });

  it("accepts ok: false", async () => {
    const res = createErrorResponse(400, "Bad Request", { ok: false });
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects invalid code options", () => {
    expect(() => createErrorResponse(400, "Bad Request", { code: 123 as unknown as string })).toThrow(TypeError);
    expect(() => createErrorResponse(400, "Bad Request", { code: "" })).toThrow(TypeError);
    expect(() => createErrorResponse(400, "Bad Request", { code: "   " })).toThrow(TypeError);
  });

  it("trims whitespace from valid code", async () => {
    const res = createErrorResponse(400, "Bad Request", { code: "  INVALID_PAYLOAD  " });
    const json = await res.json();
    expect(json.code).toBe("INVALID_PAYLOAD");
  });

  it("rejects invalid retryAfter options", () => {
    expect(() => createErrorResponse(429, "Rate limited", { retryAfter: -1 })).toThrow(TypeError);
    expect(() => createErrorResponse(429, "Rate limited", { retryAfter: -60 })).toThrow(TypeError);
    expect(() => createErrorResponse(429, "Rate limited", { retryAfter: 1.5 })).toThrow(TypeError);
    expect(() => createErrorResponse(429, "Rate limited", { retryAfter: NaN })).toThrow(TypeError);
  });

  it("accepts valid retryAfter integers including zero", async () => {
    const resZero = createErrorResponse(429, "Rate limited", { retryAfter: 0 });
    const jsonZero = await resZero.json();
    expect(jsonZero.retryAfter).toBe(0);

    const resPositive = createErrorResponse(429, "Rate limited", { retryAfter: 60 });
    const jsonPositive = await resPositive.json();
    expect(jsonPositive.retryAfter).toBe(60);
  });
});

describe("createErrorResponse - Canonical Body & Key Order", () => {
  it("guarantees error is the first key in JSON serialization", async () => {
    const res = createErrorResponse(400, "Basic error");
    const json = await res.json();
    const keys = Object.keys(json);

    expect(keys.length).toBe(1);
    expect(keys[0]).toBe("error");
    expect(json.error).toBe("Basic error");
  });

  it("orders keys canonically: error, code, retryAfter, ok", async () => {
    const res = createErrorResponse(429, "Too many requests", {
      code: "RATE_LIMITED",
      retryAfter: 45,
      ok: false,
    });
    const json = await res.json();
    const keys = Object.keys(json);

    expect(keys).toEqual(["error", "code", "retryAfter", "ok"]);
    expect(json.error).toBe("Too many requests");
    expect(json.code).toBe("RATE_LIMITED");
    expect(json.retryAfter).toBe(45);
    expect(json.ok).toBe(false);
  });

  it("forbids arbitrary extra keys in canonical error response", async () => {
    const res = createErrorResponse(404, "Not Found", {
      code: "RESOURCE_MISSING",
    });
    const json = await res.json();
    const keys = Object.keys(json);

    expect(keys).toEqual(["error", "code"]);
    expect(json).not.toHaveProperty("details");
    expect(json).not.toHaveProperty("stack");
  });
});

describe("createErrorResponse - Headers & Content-Type", () => {
  it("defaults Content-Type to application/json", () => {
    const res = createErrorResponse(400, "Invalid payload");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("preserves custom headers provided as an object", () => {
    const res = createErrorResponse(400, "Invalid payload", {
      headers: {
        "X-Request-Id": "req-12345",
        "X-Service-Name": "api-gateway",
      },
    });

    expect(res.headers.get("X-Request-Id")).toBe("req-12345");
    expect(res.headers.get("X-Service-Name")).toBe("api-gateway");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("preserves custom headers provided as a Headers instance", () => {
    const customHeaders = new Headers();
    customHeaders.set("X-Trace-Id", "trace-9876");

    const res = createErrorResponse(500, "Crash", {
      headers: customHeaders,
    });

    expect(res.headers.get("X-Trace-Id")).toBe("trace-9876");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("preserves custom Content-Type if explicitly provided in headers", () => {
    const res = createErrorResponse(400, "Problem details", {
      headers: {
        "Content-Type": "application/problem+json",
      },
    });

    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
  });
});

describe("createErrorResponse - Retry-After Header Handling", () => {
  it("automatically sets Retry-After header when retryAfter option is provided", () => {
    const res = createErrorResponse(429, "Rate limited", { retryAfter: 30 });
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("preserves an explicitly supplied Retry-After header", () => {
    const res = createErrorResponse(429, "Rate limited", {
      retryAfter: 30,
      headers: {
        "Retry-After": "120",
      },
    });

    // The explicitly supplied header must not be overwritten
    expect(res.headers.get("Retry-After")).toBe("120");
  });

  it("does not set Retry-After header when retryAfter is omitted", () => {
    const res = createErrorResponse(400, "Bad request");
    expect(res.headers.get("Retry-After")).toBeNull();
  });
});

describe("Convenience Helpers & Default Messages", () => {
  it("badRequest returns status 400 and given error", async () => {
    const res = badRequest("Invalid query parameter", { code: "INVALID_PARAM" });
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toBe("Invalid query parameter");
    expect(json.code).toBe("INVALID_PARAM");
  });

  it("unauthorized returns status 401 with default or custom message", async () => {
    const resDefault = unauthorized();
    expect(resDefault.status).toBe(401);
    expect((await resDefault.json()).error).toBe("Missing or invalid authorization token");

    const resCustom = unauthorized("Token expired", { code: "AUTH_EXPIRED" });
    expect(resCustom.status).toBe(401);
    const jsonCustom = await resCustom.json();
    expect(jsonCustom.error).toBe("Token expired");
    expect(jsonCustom.code).toBe("AUTH_EXPIRED");
  });

  it("forbidden returns status 403 with default or custom message", async () => {
    const resDefault = forbidden();
    expect(resDefault.status).toBe(403);
    expect((await resDefault.json()).error).toBe("Forbidden");

    const resCustom = forbidden("Insufficient permissions", { code: "FORBIDDEN" });
    expect(resCustom.status).toBe(403);
    const jsonCustom = await resCustom.json();
    expect(jsonCustom.error).toBe("Insufficient permissions");
    expect(jsonCustom.code).toBe("FORBIDDEN");
  });

  it("notFound returns status 404 with default or custom message", async () => {
    const resDefault = notFound();
    expect(resDefault.status).toBe(404);
    expect((await resDefault.json()).error).toBe("Resource not found");

    const resCustom = notFound("Job listing expired", { code: "JOB_EXPIRED" });
    expect(resCustom.status).toBe(404);
    const jsonCustom = await resCustom.json();
    expect(jsonCustom.error).toBe("Job listing expired");
    expect(jsonCustom.code).toBe("JOB_EXPIRED");
  });

  it("rateLimited returns status 429 with default or custom message and sets Retry-After", async () => {
    const resDefault = rateLimited();
    expect(resDefault.status).toBe(429);
    expect((await resDefault.json()).error).toBe("Too many requests. Please try again later.");
    expect(resDefault.headers.get("Retry-After")).toBeNull();

    const resCustom = rateLimited("Limit exceeded", 45, { code: "QUOTA_EXCEEDED" });
    expect(resCustom.status).toBe(429);
    expect(resCustom.headers.get("Retry-After")).toBe("45");
    const jsonCustom = await resCustom.json();
    expect(jsonCustom.error).toBe("Limit exceeded");
    expect(jsonCustom.retryAfter).toBe(45);
    expect(jsonCustom.code).toBe("QUOTA_EXCEEDED");
  });

  it("internalError returns status 500 with default or custom message", async () => {
    const resDefault = internalError();
    expect(resDefault.status).toBe(500);
    expect((await resDefault.json()).error).toBe("Internal server error");

    const resCustom = internalError("Database connection lost", { code: "DB_DOWN" });
    expect(resCustom.status).toBe(500);
    const jsonCustom = await resCustom.json();
    expect(jsonCustom.error).toBe("Database connection lost");
    expect(jsonCustom.code).toBe("DB_DOWN");
  });

  it("serviceUnavailable returns status 503 with default or custom message", async () => {
    const resDefault = serviceUnavailable();
    expect(resDefault.status).toBe(503);
    expect((await resDefault.json()).error).toBe("Service temporarily unavailable");

    const resCustom = serviceUnavailable("Maintenance in progress", { code: "MAINTENANCE" });
    expect(resCustom.status).toBe(503);
    const jsonCustom = await resCustom.json();
    expect(jsonCustom.error).toBe("Maintenance in progress");
    expect(jsonCustom.code).toBe("MAINTENANCE");
  });
});
