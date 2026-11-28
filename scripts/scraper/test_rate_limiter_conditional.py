"""Row 81: conditional-fetch (HTTP 304) handling in request_with_backoff.

Runs against a real httpx.AsyncClient with httpx.MockTransport (the actual
httpx request, redirect and raise_for_status path; only the network is faked).
"""

from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

import httpx

from scripts.scraper.rate_limiter import (
    PerHostRateLimiter,
    RequestHTTPError,
    conditional_headers,
    is_not_modified,
    request_with_backoff,
)

URL = "https://boards.example.com/jobs.json"


async def _no_sleep(_delay: float) -> None:
    return None


VALIDATORS = {"If-None-Match": '"v1"', "If-Modified-Since": "Sat, 28 Nov 2026 00:00:00 GMT"}


def _run(handler, **kwargs):
    async def _go():
        limiter = PerHostRateLimiter(default_rps=5.0)
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            follow_redirects=kwargs.pop("follow_redirects", False),
        ) as client:
            with patch("asyncio.sleep", _no_sleep):
                return await request_with_backoff(client, limiter, "GET", URL, **kwargs)

    return asyncio.run(_go())


class ConditionalFetchTests(unittest.TestCase):
    def test_current_default_304_raises_typed_error_not_success(self) -> None:
        """Default (no opt-in): 304 is an error, never a normal success body."""
        with self.assertRaises(RequestHTTPError) as ctx:
            _run(lambda r: httpx.Response(304))
        self.assertEqual(ctx.exception.status_code, 304)

    def test_304_with_opt_in_returns_unchanged_marker(self) -> None:
        resp = _run(lambda r: httpx.Response(304, headers={"ETag": '"abc"'}), allow_not_modified=True, headers=VALIDATORS)
        self.assertEqual(resp.status_code, 304)
        self.assertTrue(is_not_modified(resp))
        self.assertEqual(resp.content, b"")

    def test_200_is_not_unchanged(self) -> None:
        resp = _run(lambda r: httpx.Response(200, json={"jobs": []}), allow_not_modified=True, headers=VALIDATORS)
        self.assertFalse(is_not_modified(resp))
        self.assertEqual(resp.json(), {"jobs": []})

    def test_200_empty_board_is_not_confused_with_304(self) -> None:
        resp = _run(lambda r: httpx.Response(200, json=[]), allow_not_modified=True, headers=VALIDATORS)
        self.assertFalse(is_not_modified(resp))

    def test_validators_are_sent_and_304_returned(self) -> None:
        seen: dict[str, str | None] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["inm"] = request.headers.get("If-None-Match")
            seen["ims"] = request.headers.get("If-Modified-Since")
            return httpx.Response(304)

        hdrs = conditional_headers(etag='"v1"', last_modified="Sat, 28 Nov 2026 00:00:00 GMT")
        resp = _run(handler, allow_not_modified=True, headers=hdrs)
        self.assertTrue(is_not_modified(resp))
        self.assertEqual(seen, {"inm": '"v1"', "ims": "Sat, 28 Nov 2026 00:00:00 GMT"})

    def test_conditional_headers_empty_when_no_validators(self) -> None:
        self.assertEqual(conditional_headers(None, None), {})
        self.assertEqual(conditional_headers("", "  "), {})
        self.assertEqual(conditional_headers(etag='"x"'), {"If-None-Match": '"x"'})

    def test_redirect_then_304_is_unchanged(self) -> None:
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.url.path)
            if request.url.path == "/jobs.json":
                return httpx.Response(302, headers={"Location": "https://boards.example.com/v2/jobs.json"})
            return httpx.Response(304)

        resp = _run(handler, allow_not_modified=True, follow_redirects=True, headers=VALIDATORS)
        self.assertTrue(is_not_modified(resp))
        self.assertEqual(calls, ["/jobs.json", "/v2/jobs.json"])

    def test_redirect_not_followed_still_errors_not_unchanged(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(302, headers={"Location": "https://boards.example.com/other"})

        with self.assertRaises(RequestHTTPError) as ctx:
            _run(handler, allow_not_modified=True, headers=VALIDATORS)
        self.assertEqual(ctx.exception.status_code, 302)

    def test_retry_503_then_304_is_unchanged(self) -> None:
        n = {"c": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            n["c"] += 1
            return httpx.Response(503) if n["c"] == 1 else httpx.Response(304)

        resp = _run(handler, allow_not_modified=True, headers=VALIDATORS)
        self.assertTrue(is_not_modified(resp))
        self.assertEqual(n["c"], 2)

    def test_304_is_not_retried(self) -> None:
        n = {"c": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            n["c"] += 1
            return httpx.Response(304)

        _run(handler, allow_not_modified=True, headers=VALIDATORS)
        self.assertEqual(n["c"], 1)

    def test_retry_exhaustion_503_still_raises_with_opt_in(self) -> None:
        with self.assertRaises(RequestHTTPError) as ctx:
            _run(lambda r: httpx.Response(503), allow_not_modified=True, max_retries=1)
        self.assertEqual(ctx.exception.status_code, 503)

    def test_other_errors_unchanged_with_opt_in(self) -> None:
        for code in (404, 500):
            with self.assertRaises(RequestHTTPError) as ctx:
                _run(lambda r, c=code: httpx.Response(c), allow_not_modified=True)
            self.assertEqual(ctx.exception.status_code, code)

    def test_is_not_modified_tolerates_non_response(self) -> None:
        self.assertFalse(is_not_modified(None))

    # --- v2: validator / origin contract -------------------------------------------------

    def test_304_without_validators_sent_is_error_even_with_opt_in(self) -> None:
        with self.assertRaises(RequestHTTPError) as ctx:
            _run(lambda r: httpx.Response(304), allow_not_modified=True)
        self.assertEqual(ctx.exception.status_code, 304)

    def test_same_origin_redirect_keeps_validators(self) -> None:
        seen: list[str | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.headers.get("If-None-Match"))
            if request.url.path == "/jobs.json":
                return httpx.Response(301, headers={"Location": "/v2/jobs.json"})  # relative, same origin
            return httpx.Response(304)

        resp = _run(handler, allow_not_modified=True, follow_redirects=True, headers=VALIDATORS)
        self.assertTrue(is_not_modified(resp))
        self.assertEqual(seen, ['"v1"', '"v1"'])

    # --- v3: cross-origin redirects are refused before the next request ----------------

    def _cross(self, location: str, *, headers=None, client_kwargs=None, call_kwargs=None, other_status=200):
        """Returns (exception, list of (host, headers dict) for every request that reached the transport)."""
        seen: list[tuple[str, dict[str, str]]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append((request.url.host, dict(request.headers)))
            if len(seen) == 1:
                return httpx.Response(302, headers={"Location": location})
            return httpx.Response(other_status)

        async def _go():
            limiter = PerHostRateLimiter(default_rps=5.0)
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(handler), follow_redirects=True, **(client_kwargs or {})
            ) as client:
                with patch("asyncio.sleep", _no_sleep):
                    return await request_with_backoff(
                        client, limiter, "GET", URL, allow_not_modified=True,
                        headers=headers if headers is not None else VALIDATORS, **(call_kwargs or {}),
                    )

        exc = None
        try:
            asyncio.run(_go())
        except Exception as e:  # noqa: BLE001
            exc = e
        return exc, seen

    def _assert_refused(self, location: str, **kw) -> None:
        exc, seen = self._cross(location, **kw)
        self.assertIsInstance(exc, RequestHTTPError, location)
        self.assertEqual(exc.status_code, 302)
        self.assertEqual(len(seen), 1, f"second request must never be sent: {seen}")
        self.assertNotIn("other.example.net", str(exc))  # Location is not echoed

    def test_cross_host_redirect_refused_before_next_request(self) -> None:
        self._assert_refused("https://other.example.net/jobs.json")

    def test_scheme_downgrade_refused(self) -> None:
        self._assert_refused("http://boards.example.com/jobs.json")

    def test_port_change_refused(self) -> None:
        self._assert_refused("https://boards.example.com:8443/jobs.json")

    def test_subdomain_is_cross_origin(self) -> None:
        self._assert_refused("https://evil.boards.example.com/jobs.json")

    def test_cross_origin_refused_with_explicit_authorization_and_cookie(self) -> None:
        self._assert_refused("https://other.example.net/x",
                             headers={**VALIDATORS, "Authorization": "Bearer synthetic", "Cookie": "sid=synthetic"})

    def test_cross_origin_refused_with_auth_tuple(self) -> None:
        self._assert_refused("https://other.example.net/x", call_kwargs={"auth": ("user", "synthetic")})

    def test_cross_origin_refused_with_client_level_auth_cookies_and_default_validators(self) -> None:
        self._assert_refused(
            "https://other.example.net/x",
            client_kwargs={"auth": ("user", "synthetic"), "cookies": {"sid": "synthetic"},
                           "headers": {"If-None-Match": '"client-default"', "Authorization": "Bearer synthetic"}},
        )

    def test_refused_even_if_target_would_answer_304_or_200(self) -> None:
        for status in (200, 304):
            self._assert_refused("https://other.example.net/x", other_status=status)

    def test_negative_control_same_origin_forwards_everything_like_httpx(self) -> None:
        seen: list[dict[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(dict(request.headers))
            if request.url.path == "/jobs.json":
                return httpx.Response(301, headers={"Location": "/v2/jobs.json"})
            return httpx.Response(304)

        async def _go():
            limiter = PerHostRateLimiter(default_rps=5.0)
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True,
                                         cookies={"sid": "synthetic"}) as client:
                return await request_with_backoff(client, limiter, "GET", URL, allow_not_modified=True,
                                                  headers={**VALIDATORS, "Authorization": "Bearer synthetic"})

        resp = asyncio.run(_go())
        self.assertTrue(is_not_modified(resp))
        self.assertEqual(len(seen), 2)
        for h in seen:
            self.assertEqual(h["if-none-match"], '"v1"')
            self.assertEqual(h["authorization"], "Bearer synthetic")
            self.assertIn("sid=synthetic", h["cookie"])

    def test_non_conditional_default_path_unchanged_cross_origin(self) -> None:
        """No validators and no opt-in: httpx's own redirect handling is used, as before."""
        hosts: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            hosts.append(request.url.host)
            if request.url.host == "boards.example.com":
                return httpx.Response(302, headers={"Location": "https://other.example.net/x"})
            return httpx.Response(200, json={"ok": 1})

        resp = _run(handler, follow_redirects=True)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(hosts, ["boards.example.com", "other.example.net"])

    def test_client_default_validator_does_not_count_as_sent(self) -> None:
        async def _go():
            limiter = PerHostRateLimiter(default_rps=5.0)
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(304)),
                                         headers={"If-None-Match": '"client-default"'}) as client:
                return await request_with_backoff(client, limiter, "GET", URL, allow_not_modified=True)

        with self.assertRaises(RequestHTTPError) as ctx:
            asyncio.run(_go())
        self.assertEqual(ctx.exception.status_code, 304)

    def test_empty_or_blank_validator_does_not_authorize_304(self) -> None:
        for hdrs in ({"If-None-Match": ""}, {"If-None-Match": "   ", "If-Modified-Since": ""}):
            with self.assertRaises(RequestHTTPError, msg=str(hdrs)) as ctx:
                _run(lambda r: httpx.Response(304), allow_not_modified=True, headers=hdrs)
            self.assertEqual(ctx.exception.status_code, 304)

    def test_empty_validator_plus_real_one_still_counts(self) -> None:
        resp = _run(lambda r: httpx.Response(304), allow_not_modified=True,
                    headers={"If-None-Match": "", "If-Modified-Since": "Sat, 28 Nov 2026 00:00:00 GMT"})
        self.assertTrue(is_not_modified(resp))

    def test_every_same_origin_hop_acquires_the_host_limiter(self) -> None:
        from unittest.mock import AsyncMock

        n = {"c": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            n["c"] += 1
            if n["c"] < 3:
                return httpx.Response(302, headers={"Location": f"/h{n['c']}"})
            return httpx.Response(304)

        async def _go():
            limiter = AsyncMock()
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True) as client:
                await request_with_backoff(client, limiter, "GET", URL, allow_not_modified=True, headers=VALIDATORS)
            return limiter.acquire.call_count

        self.assertEqual(asyncio.run(_go()), 3)
        self.assertEqual(n["c"], 3)

    def test_reviewer_negatives_cross_host_never_reaches_second_request(self) -> None:
        """Peer D reviewer's five negatives, adapted: v3 refuses the hop, so no second request exists to inspect."""
        for kw in (
            {"headers": {**VALIDATORS, "Authorization": "Bearer synthetic-auth", "Cookie": "synthetic-session=yes"}},
            {"call_kwargs": {"auth": ("synthetic-user", "synthetic-password")}},
            {"client_kwargs": {"headers": {"If-None-Match": "synthetic-default-validator"}}},
        ):
            self._assert_refused("https://other.example/jobs", **kw)

    def test_header_case_insensitive_validator_detection(self) -> None:
        resp = _run(lambda r: httpx.Response(304), allow_not_modified=True, headers={"if-none-match": '"z"'})
        self.assertTrue(is_not_modified(resp))

    def test_non_get_with_opt_in_is_refused(self) -> None:
        async def _go() -> None:
            limiter = PerHostRateLimiter(default_rps=5.0)
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200))) as client:
                await request_with_backoff(client, limiter, "POST", URL, allow_not_modified=True, headers=VALIDATORS)

        with self.assertRaises(ValueError):
            asyncio.run(_go())

    def test_redirect_loop_with_validators_is_bounded(self) -> None:
        n = {"c": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            n["c"] += 1
            return httpx.Response(302, headers={"Location": "/loop"})

        with self.assertRaises(httpx.TooManyRedirects):
            _run(handler, allow_not_modified=True, follow_redirects=True, headers=VALIDATORS)
        self.assertLessEqual(n["c"], 6)

    def test_client_level_follow_redirects_is_respected(self) -> None:
        async def _go():
            def handler(request: httpx.Request) -> httpx.Response:
                if request.url.path == "/jobs.json":
                    return httpx.Response(302, headers={"Location": "/b"})
                return httpx.Response(304)

            limiter = PerHostRateLimiter(default_rps=5.0)
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True) as client:
                return await request_with_backoff(client, limiter, "GET", URL, allow_not_modified=True, headers=VALIDATORS)

        self.assertTrue(is_not_modified(asyncio.run(_go())))


if __name__ == "__main__":
    unittest.main()
