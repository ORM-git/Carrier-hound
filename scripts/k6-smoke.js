import http from "k6/http";
import { check, sleep } from "k6";

// Target URL must be explicitly set via K6_BASE_URL. Fails closed if unset.
const BASE_URL = __ENV.K6_BASE_URL;
if (!BASE_URL || BASE_URL.trim() === "") {
  throw new Error("FATAL: K6_BASE_URL environment variable is required (e.g. K6_BASE_URL=http://localhost:3000). No default to production live site is permitted.");
}

// Clean trailing slash
const sanitizedBaseUrl = BASE_URL.replace(/\/+$/, "");

export const options = {
  vus: 20,
  duration: "2m",
  thresholds: {
    // 95% of requests must complete below 1500ms
    http_req_duration: ["p(95)<1500"],
    // Error rate must remain below 1%
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  // Public GET endpoints to smoke test
  const endpoints = [
    "/",
    "/job-search/all",
    "/api/stats",
    "/job-search/remote",
  ];

  for (const endpoint of endpoints) {
    const url = `${sanitizedBaseUrl}${endpoint}`;
    const res = http.get(url, {
      tags: { name: endpoint },
      headers: {
        "Accept": "text/html,application/json,*/*",
        "User-Agent": "k6-smoke-test/1.0",
      },
    });

    check(res, {
      [`${endpoint} status is 200`]: (r) => r.status === 200,
    });

    sleep(1);
  }
}
