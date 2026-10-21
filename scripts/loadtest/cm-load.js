import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

// --- CONFIGURATION ---
const BASE_URL = (__ENV.BASE_URL || 'https://carrier-hound.pages.dev').replace(/\/+$/, '');
const IS_FULL = __ENV.FULL === '1';

// Request Caps (Hard limits across entire test run)
const MAX_STATS_REQUESTS = 20000;
const MAX_JOBS_GROUP_REQUESTS = 12000; // between 10,000 and 15,000

// Custom Safety & Tracking Metrics
const rateLimitHits = new Counter('rate_limit_hits');
const cfChallengeHits = new Counter('cf_challenge_hits');
const requestErrors = new Counter('custom_request_errors');

// Per-Endpoint Dedicated Trends
const trendHome = new Trend('duration_home', true);
const trendJobsShell = new Trend('duration_jobs_shell', true);
const trendStats = new Trend('duration_stats', true);
const trendJobsCategory = new Trend('duration_jobs_category', true);
const trendJobsSearch = new Trend('duration_jobs_search', true);

// Per-Endpoint Request Counters
const countHome = new Counter('count_home');
const countJobsShell = new Counter('count_jobs_shell');
const countStats = new Counter('count_stats');
const countJobsCategory = new Counter('count_jobs_category');
const countJobsSearch = new Counter('count_jobs_search');

// Per-Endpoint Error Counters
const errHome = new Counter('err_home');
const errJobsShell = new Counter('err_jobs_shell');
const errStats = new Counter('err_stats');
const errJobsCategory = new Counter('err_jobs_category');
const errJobsSearch = new Counter('err_jobs_search');

// Stages definition
const defaultStages = [
  { duration: '2m', target: 50 },   // 50 VUs for 2 min
  { duration: '2m', target: 200 },  // 200 VUs for 2 min
  { duration: '30s', target: 0 },   // ramp down 30s
];

const fullStages = [
  { duration: '2m', target: 50 },   // 50 VUs for 2 min
  { duration: '2m', target: 200 },  // 200 VUs for 2 min
  { duration: '2m', target: 500 },  // 500 VUs for 2 min
  { duration: '2m', target: 1000 }, // 1000 VUs for 2 min
  { duration: '30s', target: 0 },   // ramp down 30s
];

export const options = {
  stages: IS_FULL ? fullStages : defaultStages,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: {
    http_req_failed: [{ threshold: 'rate<0.02', abortOnFail: true, delayAbortEval: '30s' }],
    http_req_duration: [{ threshold: 'p(95)<3000', abortOnFail: true, delayAbortEval: '30s' }],
    rate_limit_hits: [{ threshold: 'count<1', abortOnFail: true }],
    cf_challenge_hits: [{ threshold: 'count<1', abortOnFail: true }],
  },
};

/**
 * Checks for Cloudflare challenges or blocking pages.
 */
function isCloudflareChallenge(res) {
  if (res.status === 403 || res.status === 503) {
    const body = typeof res.body === 'string' ? res.body : '';
    const headers = res.headers || {};
    const cfRay = headers['Cf-Ray'] || headers['cf-ray'];
    if (
      body.includes('cf-browser-verification') ||
      body.includes('challenge-platform') ||
      body.includes('Attention Required! | Cloudflare') ||
      body.includes('Just a moment...') ||
      cfRay
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Safe GET wrapper with metrics recording and defense abort triggers.
 */
function safeGet(endpoint, tagName, trendMetric, countMetric, errMetric) {
  const url = `${BASE_URL}${endpoint}`;
  const res = http.get(url, {
    tags: { name: tagName },
    headers: {
      'Accept': endpoint.startsWith('/api') ? 'application/json' : 'text/html,application/xhtml+xml',
      'User-Agent': 'k6-careermonke-loadtest/1.0',
    },
  });

  // Record metrics
  countMetric.add(1);
  trendMetric.add(res.timings.duration);

  // Check for HTTP 429 Rate Limiting
  if (res.status === 429) {
    rateLimitHits.add(1);
    errMetric.add(1);
    requestErrors.add(1);
    exec.test.abort(`[ABORT] Hit HTTP 429 Rate Limit on ${url}`);
    return res;
  }

  // Check for Cloudflare Challenge / Bot Defense
  if (isCloudflareChallenge(res)) {
    cfChallengeHits.add(1);
    errMetric.add(1);
    requestErrors.add(1);
    exec.test.abort(`[ABORT] Hit Cloudflare Challenge (${res.status}) on ${url}`);
    return res;
  }

  // General error check (status >= 400)
  if (res.status >= 400) {
    errMetric.add(1);
    requestErrors.add(1);
  }

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  return res;
}

export default function () {
  const iter = exec.scenario.iterationInTest;

  // 1. Static shell: GET / or GET /jobs (HTML only, alternating)
  if (iter % 2 === 0) {
    safeGet('/', 'home', trendHome, countHome, errHome);
  } else {
    safeGet('/jobs', 'jobs_shell', trendJobsShell, countJobsShell, errJobsShell);
  }

  // 2. GET /api/stats (Hard capped at MAX_STATS_REQUESTS across test run)
  if (iter < MAX_STATS_REQUESTS) {
    safeGet('/api/stats', 'stats', trendStats, countStats, errStats);
  }

  // 3. Guest jobs queries (Hard capped at MAX_JOBS_GROUP_REQUESTS across test run)
  // Hits the first page of cards, category filter, and search query
  if (iter < MAX_JOBS_GROUP_REQUESTS) {
    const selector = iter % 3;
    if (selector === 0) {
      safeGet('/jobs', 'jobs_first_page', trendJobsShell, countJobsShell, errJobsShell);
    } else if (selector === 1) {
      safeGet('/jobs?category=engineering', 'jobs_category', trendJobsCategory, countJobsCategory, errJobsCategory);
    } else {
      safeGet('/jobs?q=engineer', 'jobs_search', trendJobsSearch, countJobsSearch, errJobsSearch);
    }
  }

  // Realistic human think time: 1 to 3 seconds
  sleep(1 + Math.random() * 2);
}

/**
 * Summary formatter for console and scripts/loadtest/summary.txt
 */
export function handleSummary(data) {
  function fmt(val, digits = 2) {
    if (val === undefined || val === null || isNaN(val)) return 'N/A';
    return Number(val).toFixed(digits);
  }

  function getTrend(name) {
    const t = data.metrics[name];
    if (!t || !t.values) return { med: 0, p90: 0, p95: 0, p99: 0, avg: 0, max: 0 };
    return {
      med: t.values['med'] || t.values['p(50)'] || 0,
      p90: t.values['p(90)'] || 0,
      p95: t.values['p(95)'] || 0,
      p99: t.values['p(99)'] || 0,
      avg: t.values['avg'] || 0,
      max: t.values['max'] || 0,
    };
  }

  function getCount(name) {
    const c = data.metrics[name];
    return c && c.values && c.values.count ? c.values.count : 0;
  }

  const totalReqs = data.metrics.http_reqs ? data.metrics.http_reqs.values.count : 0;
  const failedReqRate = data.metrics.http_req_failed ? data.metrics.http_req_failed.values.rate : 0;
  const overallDuration = getTrend('http_req_duration');

  const cfHits = getCount('cf_challenge_hits');
  const rlHits = getCount('rate_limit_hits');

  const endpoints = [
    { name: 'GET / (home)', trend: 'duration_home', count: 'count_home', err: 'err_home' },
    { name: 'GET /jobs (jobs shell)', trend: 'duration_jobs_shell', count: 'count_jobs_shell', err: 'err_jobs_shell' },
    { name: 'GET /api/stats', trend: 'duration_stats', count: 'count_stats', err: 'err_stats' },
    { name: 'GET /jobs?category=engineering', trend: 'duration_jobs_category', count: 'count_jobs_category', err: 'err_jobs_category' },
    { name: 'GET /jobs?q=engineer', trend: 'duration_jobs_search', count: 'count_jobs_search', err: 'err_jobs_search' },
  ];

  let out = '';
  out += '================================================================================\n';
  out += '                 CAREERMONKE K6 READ-ONLY LOAD TEST REPORT                     \n';
  out += '================================================================================\n';
  out += `Target URL       : ${BASE_URL}\n`;
  out += `Mode             : ${IS_FULL ? 'FULL (Up to 1000 VUs)' : 'DEFAULT (50 -> 200 VUs)'}\n`;
  out += `Timestamp (UTC)  : ${new Date().toISOString()}\n`;
  out += `Total Requests   : ${totalReqs}\n`;
  out += `Overall Failure  : ${fmt(failedReqRate * 100, 2)}%\n`;
  out += `Overall Latency  : p50 = ${fmt(overallDuration.med, 1)}ms | p90 = ${fmt(overallDuration.p90, 1)}ms | p95 = ${fmt(overallDuration.p95, 1)}ms | p99 = ${fmt(overallDuration.p99, 1)}ms\n`;
  out += `HTTP 429 Hits    : ${rlHits}\n`;
  out += `CF Challenges    : ${cfHits}\n`;
  out += '--------------------------------------------------------------------------------\n';
  out += 'ENDPOINT BENCHMARKS:\n';
  out += '--------------------------------------------------------------------------------\n';
  out += 'Endpoint                       |  Requests | Errors | Error % |   p50   |   p95   |   p99   |\n';
  out += '-------------------------------+-----------+--------+---------+---------+---------+---------|\n';

  for (const ep of endpoints) {
    const tr = getTrend(ep.trend);
    const cnt = getCount(ep.count);
    const errCnt = getCount(ep.err);
    const errPct = cnt > 0 ? (errCnt / cnt) * 100 : 0;

    const padName = ep.name.padEnd(30, ' ');
    const padCnt = String(cnt).padStart(9, ' ');
    const padErr = String(errCnt).padStart(6, ' ');
    const padErrPct = (fmt(errPct, 1) + '%').padStart(7, ' ');
    const padP50 = (fmt(tr.med, 0) + 'ms').padStart(7, ' ');
    const padP95 = (fmt(tr.p95, 0) + 'ms').padStart(7, ' ');
    const padP99 = (fmt(tr.p99, 0) + 'ms').padStart(7, ' ');

    out += `${padName} | ${padCnt} | ${padErr} | ${padErrPct} | ${padP50} | ${padP95} | ${padP99} |\n`;
  }

  out += '--------------------------------------------------------------------------------\n';
  const thresholdsMet = failedReqRate < 0.02 && overallDuration.p95 < 3000 && rlHits === 0 && cfHits === 0;
  out += `VERDICT: ${thresholdsMet ? 'PASS (All thresholds satisfied, no defense triggered)' : 'FAIL / ABORTED'}\n`;
  out += '================================================================================\n';

  return {
    stdout: out,
    'scripts/loadtest/summary.txt': out,
  };
}
