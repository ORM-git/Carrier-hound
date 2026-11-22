import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const fixturePath = resolve('scripts/fixtures/python-greenhouse-canary.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  jobs: Array<{ id: number | string; absolute_url: string }>;
};
const slug = 'stripe';
const job = fixture.jobs.find((candidate) => String(candidate.id) === '8172510');
assert.ok(job, 'recorded Greenhouse job fixture must exist');

const existingTsRow = {
  id: 'existing-ts-row-8172510',
  source_id: 'greenhouse:stripe',
  source_type: 'ats',
  source_job_id: `${slug}-${job.id}`,
  apply_url: job.absolute_url,
};

const python = String.raw`
import asyncio
import json
import sys
import httpx
from scripts.scraper.engine import partition_set_diff
from scripts.scraper.fetchers import fetch_greenhouse
from scripts.scraper.rate_limiter import PerHostRateLimiter

input_data = json.load(sys.stdin)
payload = input_data["fixture"]
existing = input_data["existing"]

def handler(_request):
    return httpx.Response(200, json=payload)

async def main():
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        jobs = await fetch_greenhouse(
            client, PerHostRateLimiter(default_rps=100),
            {"name": "Stripe", "slug": "stripe", "token": "stripe"},
        )
    candidate_jobs = [j for j in jobs if j["source_job_id"] == existing["source_job_id"]]
    inserts, updates, unchanged = partition_set_diff(candidate_jobs, [existing])
    print(json.dumps({
        "inserts": len(inserts),
        "updates": [row_id for row_id, _row in updates],
        "unchanged": unchanged,
        "python_source_job_id": next(j["source_job_id"] for j in candidate_jobs),
        "apply_urls": [row["apply_url"] for _row_id, row in updates],
    }))

asyncio.run(main())
`;

const result = spawnSync('python', ['-c', python], {
  input: JSON.stringify({ fixture, existing: existingTsRow }),
  encoding: 'utf8',
  cwd: process.cwd(),
});
assert.equal(result.status, 0, result.stderr || 'Python transition check failed');
const transition = JSON.parse(result.stdout) as {
  inserts: number;
  updates: string[];
  unchanged: string[];
  python_source_job_id: string;
  apply_urls: string[];
};

assert.equal(transition.python_source_job_id, existingTsRow.source_job_id);
assert.equal(transition.inserts, 0);
assert.ok(
  transition.updates.includes(existingTsRow.id) || transition.unchanged.includes(existingTsRow.id),
  'the existing TypeScript-shaped row must keep its id',
);
assert.ok(transition.apply_urls.every((url) => url === existingTsRow.apply_url), 'apply URL must not conflict');
console.log('Python/TypeScript Greenhouse transition passed: existing row reused, no insert or apply URL conflict.');
