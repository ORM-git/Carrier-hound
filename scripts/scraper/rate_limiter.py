"""Per-host token-bucket rate limiter and HTTP 429 exponential backoff."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import email.utils
import random
import re
import time
from typing import Any
from urllib.parse import urlparse

import httpx


class RequestHTTPError(RuntimeError):
    """Redacted HTTP error with a typed status for narrowly scoped caller policy."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def conditional_headers(etag: str | None = None, last_modified: str | None = None) -> dict[str, str]:
    """Builds If-None-Match / If-Modified-Since request headers from stored validators.

    Returns an empty dict when no usable validator is given (full fetch).
    """
    headers: dict[str, str] = {}
    if etag and etag.strip():
        headers["If-None-Match"] = etag.strip()
    if last_modified and last_modified.strip():
        headers["If-Modified-Since"] = last_modified.strip()
    return headers


def is_not_modified(response: httpx.Response | None) -> bool:
    """True only for an HTTP 304 response: the board is unchanged and carries NO listing.

    Callers must treat this as "unchanged", never as an empty board: do not build a
    snapshot from it and do not expire jobs because of it. request_with_backoff only
    returns a 304 when validators were sent to the original origin (see allow_not_modified).
    """
    return response is not None and response.status_code == 304


_VALIDATOR_HEADERS = ("if-none-match", "if-modified-since")
_REDIRECT_STATUSES = (301, 302, 303, 307, 308)
_MAX_CONDITIONAL_REDIRECTS = 5


def _origin(url: httpx.URL) -> tuple[str, str, int | None]:
    port = url.port
    if port is None:
        port = {"http": 80, "https": 443}.get(url.scheme)
    return (url.scheme, url.host.lower(), port)


def _has_validators(headers: Any) -> bool:
    if not headers:
        return False
    return any(v.strip() for k, v in httpx.Headers(headers).items() if k.lower() in _VALIDATOR_HEADERS)


async def _send_conditional(
    client: httpx.AsyncClient,
    limiter: PerHostRateLimiter,
    method: str,
    url: str,
    kwargs: dict[str, Any],
    safe_url: str,
) -> httpx.Response:
    """Sends a request that carries validators. Redirects stay on the ORIGINAL origin or the call fails.

    httpx's automatic redirect is switched off for this call. A redirect is followed only when its target
    has the same scheme, host and port; the next request reuses the same arguments, so headers, cookies
    and auth behave as they do for any same-origin request. Any scheme/host/port change (including
    https to http) raises BEFORE the next request is sent, so no validator, Authorization, Cookie, auth
    tuple or client default header is ever sent to another origin.
    """
    follow = kwargs.pop("follow_redirects", client.follow_redirects)
    kw = {**kwargs, "follow_redirects": False}
    origin = _origin(httpx.URL(url))
    current_url = httpx.URL(url)
    for hop in range(_MAX_CONDITIONAL_REDIRECTS + 1):
        if hop:  # the caller already acquired the limiter for hop 0
            await limiter.acquire(str(current_url))
        response = await client.request(method, current_url, **kw)
        loc = response.headers.get("Location")
        if not follow or response.status_code not in _REDIRECT_STATUSES or not loc:
            return response
        try:
            nxt = current_url.join(loc)
        except httpx.InvalidURL:
            raise RequestHTTPError(f"Invalid redirect target requesting {safe_url}", response.status_code) from None
        if _origin(nxt) != origin:
            raise RequestHTTPError(
                f"Cross-origin redirect refused for conditional request {safe_url}", response.status_code
            )
        current_url = nxt
    raise httpx.TooManyRedirects("Exceeded maximum redirects", request=response.request)


def redact_sensitive_params(text: str) -> str:
    """Masks secret values like app_key, api_key, token, password, secret in URLs, headers, or error strings."""
    if not text:
        return ""
    pattern = r"((?:app_key|app_id|api_key|token|secret|password|key|apikey)=)([^&\s'\"]+)"
    return re.sub(pattern, r"\1[REDACTED]", text, flags=re.IGNORECASE)


def parse_retry_after(header_value: str | None, default_delay: float = 1.0) -> float:
    """Parses Retry-After header: integer seconds or RFC 7231 / RFC 2822 HTTP-date string."""
    if not header_value:
        return default_delay
    s = header_value.strip()
    if s.isdigit():
        return max(0.0, float(s))
    try:
        dt = email.utils.parsedate_to_datetime(s)
        if dt is not None:
            now_dt = datetime.now(timezone.utc)
            delay = (dt - now_dt).total_seconds()
            return max(0.0, delay)
    except Exception:
        pass
    return default_delay


class HostTokenBucket:
    """
    Async token bucket enforcing proper spacing between requests for a single host.
    At 4.0 req/s, requests are spaced by at least 1 / 4.0 = 0.25s.
    Concurrent callers are scheduled in queue order so 20 concurrent requests
    are properly spaced over time rather than executing in a 0.25s burst.
    """

    def __init__(self, rate_per_sec: float = 4.0, capacity: float = 1.0) -> None:
        self.rate = max(0.5, min(rate_per_sec, 5.0))
        self.capacity = max(1.0, capacity)
        self.min_spacing = 1.0 / self.rate
        self.tokens = self.capacity
        self.last_update = time.monotonic()
        self.next_available_time = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            if now > self.last_update:
                elapsed = now - self.last_update
                self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
                self.last_update = now

            if self.tokens >= 1.0:
                self.tokens -= 1.0
                self.next_available_time = max(now, self.next_available_time) + self.min_spacing
                wait_seconds = 0.0
            else:
                sched_time = max(now, self.next_available_time)
                wait_seconds = sched_time - now
                self.next_available_time = sched_time + self.min_spacing
                self.tokens = 0.0
                self.last_update = sched_time

        if wait_seconds > 0.0:
            await asyncio.sleep(wait_seconds)


class PerHostRateLimiter:
    """Registry of per-host token buckets."""

    def __init__(self, default_rps: float = 4.0, burst: float = 1.0) -> None:
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
    allow_not_modified: bool = False,
    **kwargs,
) -> httpx.Response:
    """Executes an HTTP request respecting per-host token buckets and 429 backoff.

    allow_not_modified=True lets a 304 come back as "unchanged" (check is_not_modified), but only when:
    the method is GET, validators (If-None-Match / If-Modified-Since) were sent in headers, and no
    no redirect left the origin. In that mode a redirect to another scheme/host/port is refused with
    RequestHTTPError (status of the redirect) before the next request is sent. A 304 in any other case
    (no validators passed in headers) raises RequestHTTPError(304). Default False: a 304 always raises.
    A 304 has no body and is never retried. Validators must come from the headers argument and be non-empty;
    client default headers and empty values are not treated as "sent". Each same-origin redirect hop
    acquires the per-host limiter like any other request.
    """
    safe_url = redact_sensitive_params(url)
    last_exc: Exception | None = None
    conditional = allow_not_modified and _has_validators(kwargs.get("headers"))
    if allow_not_modified and method.upper() != "GET":
        raise ValueError("allow_not_modified is only valid for GET requests")
    for attempt in range(max_retries + 1):
        await limiter.acquire(url)
        try:
            if conditional:
                response = await _send_conditional(client, limiter, method, url, dict(kwargs), safe_url)
            else:
                response = await client.request(method, url, **kwargs)
            if response.status_code == 429 or response.status_code in (502, 503, 504):
                if attempt >= max_retries:
                    response.raise_for_status()
                retry_after_hdr = response.headers.get("Retry-After")
                if retry_after_hdr:
                    delay = parse_retry_after(retry_after_hdr, default_delay=base_backoff * (2**attempt))
                    await asyncio.sleep(delay)
                else:
                    delay = base_backoff * (2**attempt) + random.uniform(0.05, 0.25)
                    await asyncio.sleep(min(delay, 30.0))
                continue
            if conditional and response.status_code == 304:
                return response
            response.raise_for_status()
            return response
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            sanitized_exc_msg = redact_sensitive_params(str(exc))
            last_exc = RuntimeError(f"Network error requesting {safe_url}: {sanitized_exc_msg}")
            if attempt >= max_retries:
                raise last_exc
            delay = base_backoff * (2**attempt) + random.uniform(0.05, 0.25)
            await asyncio.sleep(min(delay, 15.0))
        except httpx.HTTPStatusError as exc:
            sanitized_err = redact_sensitive_params(str(exc))
            raise RequestHTTPError(f"HTTP error requesting {safe_url}: {sanitized_err}", exc.response.status_code) from None

    if last_exc:
        raise last_exc
    raise RuntimeError(f"Exhausted retries for {method} {safe_url}")
