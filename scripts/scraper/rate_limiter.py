"""Per-host token-bucket rate limiter and HTTP 429 exponential backoff."""

from __future__ import annotations

import asyncio
import random
import time
from urllib.parse import urlparse

import httpx


class HostTokenBucket:
    """Async token bucket enforcing 3-5 requests/sec per host."""

    def __init__(self, rate_per_sec: float = 4.0, capacity: float = 5.0) -> None:
        self.rate = max(0.5, min(rate_per_sec, 5.0))
        self.capacity = max(1.0, capacity)
        self.tokens = self.capacity
        self.updated_at = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            elapsed = max(0.0, now - self.updated_at)
            self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
            self.updated_at = now

            if self.tokens >= 1.0:
                self.tokens -= 1.0
                return

            wait_seconds = (1.0 - self.tokens) / self.rate
            self.tokens = 0.0
            self.updated_at = now + wait_seconds

        await asyncio.sleep(wait_seconds)


class PerHostRateLimiter:
    """Registry of per-host token buckets."""

    def __init__(self, default_rps: float = 4.0, burst: float = 5.0) -> None:
        self.default_rps = max(0.5, min(default_rps, 5.0))
        self.burst = max(1.0, burst)
        self._buckets: dict[str, HostTokenBucket] = {}

    def _bucket_for(self, url: str) -> HostTokenBucket:
        host = (urlparse(url).hostname or "default").lower()
        bucket = self._buckets.get(host)
        if bucket is None:
            bucket = HostTokenBucket(rate_per_sec=self.default_rps, capacity=self.burst)
            self._buckets[host] = bucket
        return bucket

    async def acquire(self, url: str) -> None:
        await self._bucket_for(url).acquire()


async def request_with_backoff(
    client: httpx.AsyncClient,
    limiter: PerHostRateLimiter,
    method: str,
    url: str,
    *,
    max_retries: int = 4,
    base_backoff: float = 1.0,
    **kwargs,
) -> httpx.Response:
    """Executes an HTTP request respecting per-host token buckets and 429 backoff."""
    last_exc: Exception | None = None
    for attempt in range(max_retries + 1):
        await limiter.acquire(url)
        try:
            response = await client.request(method, url, **kwargs)
            if response.status_code == 429 or response.status_code in (502, 503, 504):
                if attempt >= max_retries:
                    response.raise_for_status()
                retry_after = response.headers.get("Retry-After")
                if retry_after and retry_after.isdigit():
                    delay = float(retry_after)
                else:
                    delay = base_backoff * (2**attempt) + random.uniform(0.05, 0.25)
                await asyncio.sleep(min(delay, 30.0))
                continue
            response.raise_for_status()
            return response
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            last_exc = exc
            if attempt >= max_retries:
                raise
            delay = base_backoff * (2**attempt) + random.uniform(0.05, 0.25)
            await asyncio.sleep(min(delay, 15.0))

    if last_exc:
        raise last_exc
    raise RuntimeError(f"Exhausted retries for {method} {url}")
