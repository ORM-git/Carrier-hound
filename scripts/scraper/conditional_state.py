"""Per-board HTTP validator state for conditional GET (a JSON file; no database table).

Same pattern as workday_schedule: a versioned JSON file carried between runs by actions/cache.
Missing, corrupt, oversized or out-of-scope state never sends a validator, so the run does a normal
full fetch. Nothing here talks to the network or the database.

A stored validator is only an optimisation hint. A board is "unchanged" only when the server answers
304 to a request that carried this validator to the same origin (enforced in request_with_backoff).
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
from typing import Any, Mapping
import re
from urllib.parse import parse_qsl, urlsplit

STATE_VERSION = 1
MAX_ENTRIES = 2000
MAX_FILE_BYTES = 1_000_000
MAX_VALIDATOR_LEN = 512
MAX_URL_LEN = 2048
MAX_SOURCE_ID_LEN = 200
MAX_ENTRY_AGE_DAYS = 14
DEFAULT_MAX_AGE_HOURS = 20
KEY_SCHEMA = "k2"
# Anonymous only. No authenticated caller exists, and one shared bucket is not per principal, so any other
# scope is refused rather than stored.
AUTH_SCOPES = ("anon",)
_SOURCE_ID_RE = re.compile(r"[A-Za-z0-9:_.\-]+")
_SENSITIVE_QUERY_PARTS = (
    "token", "key", "secret", "auth", "password", "passwd", "pwd", "signature", "sig", "credential",
    "session", "bearer", "cookie", "jwt", "access", "apikey", "api_key",
)


def board_key(source_id: str, url: str, auth_scope: str = "anon") -> str:
    """State key bound to schema, auth scope, board and the EXACT url (path and query as fetched).

    A changed query string (for example content=true vs not) or an anonymous vs authenticated fetch is a
    different key, so a validator is never reused for a different representation.
    """
    if auth_scope not in AUTH_SCOPES:
        raise ValueError(f"unsupported auth_scope {auth_scope!r}: the cache is anonymous-only")
    if not _safe_source_id(source_id) or not _safe_url(url):
        raise ValueError("source_id or url is not a safe public anonymous cache key")
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
    return f"{KEY_SCHEMA}|{auth_scope}|{source_id}|{digest}"


@dataclass(frozen=True)
class BoardUnchanged:
    """A fetcher's result for a validated 304: no listing was returned. Never an empty board."""

    source_id: str
    url: str


def max_age_hours() -> int:
    """Forced full-fetch age. Env CONDITIONAL_MAX_AGE_HOURS, clamped 1..48 (expiry cutoff is 72h)."""
    try:
        v = int(os.environ.get("CONDITIONAL_MAX_AGE_HOURS", DEFAULT_MAX_AGE_HOURS))
    except ValueError:
        v = DEFAULT_MAX_AGE_HOURS
    return max(1, min(v, 48))


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _parse(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _origin(url: str) -> tuple[str, str, int | None] | None:
    try:
        p = urlsplit(url)
        host = (p.hostname or "").lower()
        if p.scheme not in ("http", "https") or not host:
            return None
        return (p.scheme, host, p.port or {"http": 80, "https": 443}[p.scheme])
    except ValueError:
        return None


def _has_control(text: str) -> bool:
    """Any C0 (incl. CR, LF, tab, NUL), DEL or C1 control character, or any non-ASCII character."""
    return any(ord(c) < 0x20 or 0x7F <= ord(c) or c.isspace() and c != " " for c in text)


def _safe_source_id(sid: Any) -> bool:
    return isinstance(sid, str) and len(sid) <= MAX_SOURCE_ID_LEN and _SOURCE_ID_RE.fullmatch(sid) is not None


def _safe_url(url: Any) -> bool:
    """Fixed public anonymous https URL only: bounded, no control or space characters, no userinfo,
    no fragment, no credential-looking query parameter."""
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LEN:
        return False
    if _has_control(url) or " " in url:
        return False
    try:
        parts = urlsplit(url)
        host = parts.hostname
        if parts.scheme != "https" or not host:
            return False
        if parts.username is not None or parts.password is not None or "@" in parts.netloc:
            return False
        if parts.fragment:
            return False
        _ = parts.port
        for name, _v in parse_qsl(parts.query, keep_blank_values=True):
            lowered = name.lower()
            if any(part in lowered for part in _SENSITIVE_QUERY_PARTS):
                return False
    except ValueError:
        return False
    return True


def _clean(value: Any) -> str | None:
    """A header value is stored only if it is a short printable ASCII single-line string.

    Control characters (C0 incl. CR/LF/tab/NUL, DEL, C1) and non-ASCII are rejected BEFORE any stripping,
    so a value that merely has CR/LF at an edge is rejected, not repaired. Plain spaces at the edges are
    trimmed. Empty or blank means no validator.
    """
    if not isinstance(value, str) or _has_control(value):
        return None
    v = value.strip(" ")
    if not v or len(v) > MAX_VALIDATOR_LEN:
        return None
    return v


def _valid_entry(entry: Any) -> bool:
    if not isinstance(entry, dict):
        return False
    present = [k for k in ("etag", "last_modified") if entry.get(k) is not None]
    if not present or any(_clean(entry[k]) is None for k in present):
        return False  # at least one validator, and every stored validator must be clean
    if not _safe_url(entry.get("url")) or _origin(entry["url"]) is None:
        return False
    if entry.get("auth_scope") not in AUTH_SCOPES or not _safe_source_id(entry.get("source_id")):
        return False
    return _parse(entry.get("last_full_fetch_at")) is not None


def load_state(path: str | None, now: datetime | None = None) -> tuple[dict[str, dict[str, Any]], str]:
    """(boards, status) with status ok / missing / corrupt. Any malformed entry makes the whole file corrupt."""
    if not path or not Path(path).is_file():
        return {}, "missing"
    try:
        if Path(path).stat().st_size > MAX_FILE_BYTES:
            raise ValueError("size")
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        boards = data["sources"]
        if data.get("version") != STATE_VERSION or not isinstance(boards, dict) or len(boards) > MAX_ENTRIES:
            raise ValueError("version/shape")
        for key, entry in boards.items():
            if not isinstance(key, str) or not _valid_entry(entry) or key != board_key(
                entry["source_id"], entry["url"], entry["auth_scope"]
            ):
                raise ValueError("entry")
        now = now or datetime.now(timezone.utc)
        if any(_parse(e["last_full_fetch_at"]) > now + timedelta(minutes=5) for e in boards.values()):
            raise ValueError("future timestamp")  # clock skew or tampering: do not trust any of it
        return _prune(dict(boards), now), "ok"
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return {}, "corrupt"


def _eviction_order(boards: dict[str, dict[str, Any]]) -> list[str]:
    """Keep-first order: newest last_full_fetch_at first; ties broken by key ascending (stable, deterministic)."""
    return sorted(boards, key=lambda k: (-_parse(boards[k]["last_full_fetch_at"]).timestamp(), k))


def _prune(boards: dict[str, dict[str, Any]], now: datetime) -> dict[str, dict[str, Any]]:
    cutoff = now - timedelta(days=MAX_ENTRY_AGE_DAYS)
    kept = {k: v for k, v in boards.items() if (_parse(v.get("last_full_fetch_at")) or cutoff) > cutoff}
    if len(kept) > MAX_ENTRIES:
        kept = {k: kept[k] for k in _eviction_order(kept)[:MAX_ENTRIES]}
    return kept


def _serialize(entries: dict[str, dict[str, Any]]) -> bytes:
    """Compact, deterministic, ASCII-only JSON, so len(bytes) is the exact file size."""
    text = json.dumps({"version": STATE_VERSION, "sources": entries}, sort_keys=True, separators=(",", ":"))
    return text.encode("ascii")


def _fit(entries: dict[str, dict[str, Any]]) -> bytes:
    """Largest set of entries whose file is at most MAX_FILE_BYTES (what load_state accepts).

    Eviction order: entries are kept newest-first (last_full_fetch_at descending, key ascending on ties)
    and the file holds the longest prefix of that order that fits. Evicted boards simply full-fetch.
    """
    order = _eviction_order(entries)
    data = _serialize({k: entries[k] for k in order})
    if len(data) <= MAX_FILE_BYTES:
        return data
    lo, hi = 0, len(order)  # invariant: lo entries fit, hi entries do not
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if len(_serialize({k: entries[k] for k in order[:mid]})) <= MAX_FILE_BYTES:
            lo = mid
        else:
            hi = mid
    return _serialize({k: entries[k] for k in order[:lo]})


def save_state(path: str | None, boards: dict[str, dict[str, Any]], now: datetime | None = None) -> None:
    """Atomic write. Never writes a file that load_state would reject for size, count or shape."""
    if not path:
        return
    pruned = _prune(
        {k: v for k, v in boards.items() if _valid_entry(v) and k == board_key(v["source_id"], v["url"], v["auth_scope"])},
        now or datetime.now(timezone.utc),
    )
    data = _fit(pruned)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, target)


def validators_for(
    boards: Mapping[str, Mapping[str, Any]],
    source_id: str,
    url: str,
    now: datetime,
    max_age: int | None = None,
    auth_scope: str = "anon",
) -> dict[str, str]:
    """Request headers for this board, or {} (full fetch).

    Empty when: no entry for this exact (schema, auth scope, board, URL incl. query); the last
    fully persisted fetch is older than max_age hours (forces a periodic full fetch so last_seen_at
    stays inside the expiry window); or the entry is malformed.
    """
    if _origin(url) is None or auth_scope not in AUTH_SCOPES or not _safe_source_id(source_id) or not _safe_url(url):
        return {}
    entry = boards.get(board_key(source_id, url, auth_scope))
    if not entry or not _valid_entry(entry) or entry["url"] != url or entry["auth_scope"] != auth_scope:
        return {}
    last = _parse(entry.get("last_full_fetch_at"))
    limit = timedelta(hours=max_age if max_age is not None else max_age_hours())
    if last is None or now - last > limit or last > now + timedelta(minutes=5):
        return {}
    headers: dict[str, str] = {}
    etag, lm = _clean(entry.get("etag")), _clean(entry.get("last_modified"))
    if etag:
        headers["If-None-Match"] = etag
    if lm:
        headers["If-Modified-Since"] = lm
    return headers


def record_full_fetch(
    boards: dict[str, dict[str, Any]],
    source_id: str,
    url: str,
    response_headers: Mapping[str, str],
    now: datetime,
    final_url: str | None = None,
    auth_scope: str = "anon",
) -> bool:
    """Store validators from a 200 whose rows were ALL persisted. Returns True if an entry was stored.

    Call only after persistence succeeded for every row of the board. Refuses (and drops any old entry)
    when the response came from another origin than the seed URL, or carries no usable validator.
    """
    if auth_scope not in AUTH_SCOPES or not _safe_source_id(source_id) or not _safe_url(url):
        return False  # never store (or keep) anything for an unsafe key
    key = board_key(source_id, url, auth_scope)
    if final_url is not None and _origin(final_url) != _origin(url):
        boards.pop(key, None)
        return False
    lower = {str(k).lower(): v for k, v in dict(response_headers).items()}
    etag, lm = _clean(lower.get("etag")), _clean(lower.get("last-modified"))
    if (etag is None and lm is None) or _origin(url) is None:
        boards.pop(key, None)
        return False
    entry: dict[str, Any] = {"source_id": source_id, "auth_scope": auth_scope, "url": url, "last_full_fetch_at": _iso(now)}
    if etag:
        entry["etag"] = etag
    if lm:
        entry["last_modified"] = lm
    boards[key] = entry
    return True


def drop(boards: dict[str, dict[str, Any]], source_id: str, url: str, auth_scope: str = "anon") -> None:
    if auth_scope in AUTH_SCOPES and _safe_source_id(source_id) and _safe_url(url):
        boards.pop(board_key(source_id, url, auth_scope), None)


# ---------------------------------------------------------------------------------------------------------
# Caller-side context (used by fetchers.py and run_ingestion.py). Layer 1 ATS boards only.
# ---------------------------------------------------------------------------------------------------------

CONDITIONAL_ATS = frozenset({"greenhouse", "lever", "ashby"})
_SLUG_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
# The ONLY URLs the cache may key or send validators to. These are byte-identical to the fetchers' own URLs.
_URL_TEMPLATES = {
    "greenhouse": "https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true&pay_transparency=true",
    "lever": "https://api.lever.co/v0/postings/{token}?mode=json",
    "ashby": "https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true",
}


def fixed_template_url(ats: str, token: str) -> str | None:
    """The fixed public anonymous URL for a board, or None for an unknown ATS or a non-public-slug token."""
    tmpl = _URL_TEMPLATES.get((ats or "").lower())
    if tmpl is None or not isinstance(token, str) or _SLUG_RE.fullmatch(token) is None:
        return None
    url = tmpl.format(token=token)
    return url if _safe_url(url) else None


def _board_template_url(board_id: str) -> str | None:
    ats, _, token = board_id.partition(":")
    return fixed_template_url(ats, token)


class ConditionalContext:
    """One run's view of the validator state: what was sent, what was captured, what may be committed.

    Nothing is written to disk here. run_ingestion saves only on a real (non-dry) write run, and only
    boards that pass finalize_board() are committed.
    """

    def __init__(
        self,
        boards: dict[str, dict[str, Any]],
        status: str,
        now: datetime,
        allowed_ats: set[str] | frozenset[str],
        max_age: int | None = None,
    ) -> None:
        self.boards = boards
        self.status = status
        self.now = now
        self.allowed_ats = frozenset(a.lower() for a in allowed_ats) & CONDITIONAL_ATS
        self.max_age = max_age
        self.sent: dict[str, str] = {}  # board_id -> url that carried validators this run
        self.pending: dict[str, dict[str, Any]] = {}  # board_id -> captured 200
        self.viewed: set[str] = set()
        self.dirty = False

    def enabled_for(self, ats: str) -> bool:
        return (ats or "").lower() in self.allowed_ats

    def view(self, board_id: str) -> "BoardView":
        self.viewed.add(board_id)
        return BoardView(self, board_id)

    def validate_unchanged(self, result: Any, expected_board_id: str) -> bool:
        """The sentinel must name this board and the exact URL that carried validators this run."""
        return (
            isinstance(result, BoardUnchanged)
            and result.source_id == expected_board_id
            and expected_board_id in self.viewed
            and self.sent.get(expected_board_id) == result.url
        )

    def drop_board(self, board_id: str) -> None:
        self.pending.pop(board_id, None)
        stale = [k for k, e in self.boards.items() if e.get("source_id") == board_id]
        for k in stale:
            del self.boards[k]
            self.dirty = True

    def finalize_board(
        self,
        board_id: str,
        *,
        jobs: list[dict[str, Any]],
        completed: bool,
        is_full_coverage: bool,
        error: Any,
        unchanged: bool,
        writes_attempted: bool,
        dry_run: bool,
        persisted_keys: set[tuple[str, str]],
        board_rejected: int,
        board_duplicates: int,
        global_veto: bool,
    ) -> str:
        """Decide commit or drop for one board after persistence. Returns unchanged / committed / dropped / none.

        Commit needs ALL of: a captured complete 200; full-coverage completed board with no error; writes
        attempted on a non-dry run; no global veto (persistence failure or ANY duplicate-skipped row in the
        run); no rejected or duplicate-skipped row on this board; no duplicate identity among the ORIGINAL fetched rows (counted before any set or collapse); every fetched row has a well-formed
        identity (source_id equal to the board id, non-empty source_job_id); and EVERY fetched identity key
        confirmed persisted. An empty 200 commits only when the fetcher proved a complete empty board.
        Anything else drops the board's entry, so the next run does a full fetch.
        """
        if board_id not in self.viewed:
            return "none"
        if unchanged:
            return "unchanged"  # state untouched: a 304 changes nothing
        cap = self.pending.pop(board_id, None)
        keys: set[tuple[str, str]] = set()
        well_formed = True
        for j in jobs:
            sid, jid = str(j.get("source_id") or ""), str(j.get("source_job_id") or "")
            if sid != board_id or not jid:
                well_formed = False
            keys.add((sid, jid))
        original_duplicates = len(keys) != len(jobs)  # counted on the ORIGINAL rows, before any collapse
        ok = (
            cap is not None
            and cap.get("complete") is True
            and completed
            and is_full_coverage
            and not error
            and writes_attempted
            and not dry_run
            and not global_veto
            and board_rejected == 0
            and board_duplicates == 0
            and well_formed
            and not original_duplicates
            and keys <= persisted_keys
        )
        if not ok:
            if not dry_run:
                self.drop_board(board_id)
            return "dropped"
        stored = record_full_fetch(self.boards, board_id, cap["url"], cap["headers"], self.now, final_url=cap["final_url"])
        self.dirty = True
        return "committed" if stored else "dropped"


class BoardView:
    """The per-board handle a fetcher receives. The board id is the run plan's id, not a fetcher guess."""

    def __init__(self, ctx: ConditionalContext, board_id: str) -> None:
        self._ctx = ctx
        self.board_id = board_id

    async def get(self, client: Any, limiter: Any, url: str) -> Any:
        """GET with stored validators when present. Returns the response, or BoardUnchanged on a valid 304."""
        from .rate_limiter import is_not_modified, request_with_backoff

        # Validators are only ever sent for the fixed template URL of this board id (public slug).
        if _board_template_url(self.board_id) != url:
            return await request_with_backoff(client, limiter, "GET", url)
        hdrs = validators_for(self._ctx.boards, self.board_id, url, self._ctx.now, self._ctx.max_age)
        if not hdrs:
            return await request_with_backoff(client, limiter, "GET", url)
        self._ctx.sent[self.board_id] = url
        resp = await request_with_backoff(client, limiter, "GET", url, allow_not_modified=True, headers=hdrs)
        if is_not_modified(resp):
            return BoardUnchanged(self.board_id, url)
        return resp

    def capture(self, url: str, response_headers: Mapping[str, str], final_url: str, *, complete: bool) -> None:
        """Remember a 200's validators. complete=False (filtered or unparsed rows, shape not proven) never commits."""
        if _board_template_url(self.board_id) != url:
            self._ctx.pending.pop(self.board_id, None)
            return  # not the fixed template for this board: nothing is captured
        self._ctx.pending[self.board_id] = {
            "url": url,
            "headers": dict(response_headers),
            "final_url": final_url,
            "complete": bool(complete),
        }
