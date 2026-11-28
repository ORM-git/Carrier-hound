"""Board verification planning for company-sheet ATS candidates (Greenhouse, Lever, Ashby, SmartRecruiters).

Input: the intake_report.json written by company_sheet_intake (PR #882). A record is planned only when its claimed
ATS and token are re-derived, identically, from its own source URL; every other record is kept with its reason.

  # default: write request_plan.json only. ZERO network requests.
  python -m scripts.scraper.board_verify --intake out/intake/intake_report.json --out-dir out/verify

  # offline replay of local fixture responses through an httpx MockTransport (still zero network); every result is
  # evidence="synthetic_fixture" and can never qualify a production seed.
  python -m scripts.scraper.board_verify --intake ... --out-dir ... --fixture-responses fixtures.json

This build has no live verification at all: the only evidence kind it accepts or emits is synthetic_fixture.
verify_plan() takes an injected client so a later, separately reviewed stage can add live evidence.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, quote, unquote, urlsplit

import httpx

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

DEFAULT_SEEDS_PATH = Path(__file__).resolve().parent / "company_seeds.json"

# Exactly the URLs the connectors in fetchers.py request, so a verified board is one the connector can read.
CONNECTORS: dict[str, dict[str, Any]] = {
    "greenhouse": {"url": "https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true&pay_transparency=true",
                   "list_key": "jobs"},
    "lever": {"url": "https://api.lever.co/v0/postings/{token}?mode=json", "list_key": None},  # top-level list
    "ashby": {"url": "https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true", "list_key": "jobs"},
    "smartrecruiters": {"url": "https://api.smartrecruiters.com/v1/companies/{token}/postings", "list_key": "content"},
}
APPROVED_HOSTS = frozenset(urlsplit(c["url"]).hostname for c in CONNECTORS.values())

# Token rules follow company_sheet_intake / ats_detect (#882): a path segment is percent-decoded once, must use this
# decoded charset, and is stored re-encoded with quote(safe="._~-"). Length capped so a plan line stays sane.
_DECODED_TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._~ -]{0,99}$")
_BAD_ESCAPE_RE = re.compile(r"%(?![0-9A-Fa-f]{2})")
_LABEL_RE = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")
_CONTROL_RE = re.compile(r"[\x00-\x20\x7f]")

SYNTHETIC = "synthetic_fixture"
EVIDENCE_KINDS = (SYNTHETIC,)  # no live evidence kind exists in this build

# Outcomes. Only VALID_WITH_JOBS is positive evidence; only NOT_FOUND is (weak) evidence the board is absent.
VALID_WITH_JOBS = "valid_with_jobs"
VALID_EMPTY = "valid_empty"
NOT_FOUND = "not_found"
RATE_LIMITED = "rate_limited"
SERVER_ERROR = "server_error"
HTTP_ERROR = "http_error"
MALFORMED = "malformed_payload"
TRANSPORT_ERROR = "transport_error"
REJECTED = "rejected_before_request"


class IntakeError(ValueError):
    pass


def board_id(ats: str, token: str) -> str:
    return f"{ats}:{token}"  # same form as the connectors' source_id


def canonical_token(raw: Any, decoded: bool = False) -> str | None:
    """The #882 canonical form of a token taken from a URL, or None when the connector URL cannot carry it."""
    if not isinstance(raw, str) or not raw:
        return None
    if not decoded:
        if _BAD_ESCAPE_RE.search(raw):
            return None
        raw = unquote(raw)
    if any(c in raw for c in "/\\?#%") or not _DECODED_TOKEN_RE.match(raw):
        return None
    return quote(raw, safe="._~-")


def is_canonical_token(token: Any) -> bool:
    return isinstance(token, str) and canonical_token(token) == token


def request_url(ats: Any, token: Any) -> str:
    """The connector's URL for this board. Raises ValueError for an unknown ATS, a bad token or a non-approved host."""
    if ats not in CONNECTORS:
        raise ValueError(f"no connector for ats {ats!r}")
    if not is_canonical_token(token):
        raise ValueError(f"invalid {ats} token {token!r}")
    url = CONNECTORS[ats]["url"].format(token=token)
    check_url(url)
    return url


def check_url(url: Any) -> None:
    """Guard before any request: https, approved connector host, no credentials or port."""
    if not isinstance(url, str):
        raise ValueError("url is not a string")
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in APPROVED_HOSTS or parts.port or parts.username or parts.password:
        raise ValueError(f"url host not approved: {parts.hostname!r}")


def derive_board(raw_url: Any) -> tuple[str, str] | None:
    """(ats, canonical token) for a Greenhouse/Lever/Ashby/SmartRecruiters board URL, using #882's URL rules; None for
    anything else (website, other ATS, unparseable, token the connector cannot carry)."""
    value = raw_url.strip() if isinstance(raw_url, str) else ""
    if not value or re.search(r"\s|,|\|", value):
        return None
    if "://" not in value:
        if value.startswith("//") or ":" in value.split("/")[0]:
            return None
        value = "https://" + value
    try:
        parts = urlsplit(value)
        parts.port  # noqa: B018 - raises on a bad port
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or parts.username or parts.password:
        return None
    try:
        host = (parts.hostname or "").rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError:
        return None
    host = host[4:] if host.startswith("www.") else host
    segs = [s for s in parts.path.split("/") if s]
    first = segs[0] if segs else None
    query = dict(parse_qsl(parts.query))

    def tok(ats: str, raw: Any, decoded: bool = False) -> tuple[str, str] | None:
        t = canonical_token(raw, decoded)
        return (ats, t) if t else None

    if host in ("boards.greenhouse.io", "job-boards.greenhouse.io"):
        return tok("greenhouse", query.get("for"), decoded=True) if first == "embed" else tok("greenhouse", first)
    if host == "boards-api.greenhouse.io":
        return tok("greenhouse", segs[2]) if segs[:2] == ["v1", "boards"] and len(segs) > 2 else None
    if host == "jobs.lever.co":
        return tok("lever", first)
    if host == "api.lever.co":
        return tok("lever", segs[2]) if segs[:2] == ["v0", "postings"] and len(segs) > 2 else None
    if host == "jobs.ashbyhq.com":
        return tok("ashby", first)
    if host == "api.ashbyhq.com":
        return tok("ashby", segs[2]) if segs[:2] == ["posting-api", "job-board"] and len(segs) > 2 else None
    if host in ("jobs.smartrecruiters.com", "careers.smartrecruiters.com"):
        return tok("smartrecruiters", first)
    if host == "api.smartrecruiters.com":
        return tok("smartrecruiters", segs[2]) if segs[:2] == ["v1", "companies"] and len(segs) > 2 else None
    return None


def record_sha256(rec: Any) -> str:
    """Fingerprint binding a plan entry and its verification result to the exact intake record."""
    return hashlib.sha256(json.dumps(rec, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def load_json(path: Path) -> Any:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise IntakeError(f"{path}: not valid JSON ({exc})") from None


def existing_boards(seeds: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """casefolded board id -> seed, for the layer-1 ATS seeds already in company_seeds.json (read only)."""
    out: dict[str, dict[str, Any]] = {}
    for s in seeds.get("layer1_public_ats") or []:
        if isinstance(s, dict) and s.get("ats") and s.get("token"):
            out[board_id(str(s["ats"]).lower(), str(s["token"])).casefold()] = s
    return out


def _is_row(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v > 0


def _record_problem(rec: dict[str, Any], rows: Counter) -> tuple[str, str] | None:
    """(skip_kind, reason) for a record that is not a clean, self-consistent candidate; None when it is."""
    row, company, ats, ids = rec.get("source_row"), rec.get("company"), rec.get("ats_candidate"), rec.get("identifiers")
    if not _is_row(row):
        return "invalid_source_row", f"source_row {row!r} is not a positive integer"
    if rows[row] > 1:
        return "conflict", f"source_row {row} appears {rows[row]} times in the intake"
    merged = rec.get("merged_into_row")
    if merged is not None:
        if not _is_row(merged) or merged == row or merged not in rows:
            return "invalid_source_row", f"merged_into_row {merged!r} does not reference another intake row"
        return "merged_duplicate", f"intake merged this row into row {merged}"
    if not isinstance(company, str) or not company.strip():
        return "missing_company", "company name blank or missing"
    if rec.get("status") != "ats_candidate":
        return "not_candidate", f"intake status {rec.get('status')!r}: {rec.get('reason')}"
    if ats not in CONNECTORS:
        return "out_of_scope_ats", f"ats {ats!r} is not verified in this stage (greenhouse/lever/ashby/smartrecruiters only)"
    if not isinstance(ids, dict) or set(ids) != {"token"}:
        return "invalid_identifier", f"identifiers {ids!r} are not exactly {{'token': ...}}"
    token = ids["token"]
    if not is_canonical_token(token):
        return "invalid_identifier", f"token {token!r} is not a connector-compatible canonical token"
    urls = rec.get("all_urls")
    col = rec.get("url_column")
    if not isinstance(urls, dict) or not isinstance(col, str) or urls.get(col) != rec.get("original_url"):
        return "url_mismatch", f"original_url is not the value of url_column {col!r} in all_urls"
    derived = derive_board(rec.get("original_url"))
    if derived != (ats, token):
        return "ats_token_mismatch", (f"claimed {ats}:{token} but source URL {rec.get('original_url')!r} derives "
                                      f"{board_id(*derived) if derived else 'no supported board'}")
    others = {board_id(*d) for u in urls.values() if (d := derive_board(u)) and d != derived}
    if others:
        return "conflict", f"other URL columns point at different boards: {sorted(others)}"
    boards = rec.get("candidate_boards")
    if boards is not None and boards != [f"{ats}:{json.dumps({'token': token}, sort_keys=True)}"]:
        return "conflict", f"candidate_boards {boards!r} disagree with the claimed board"
    if rec.get("review_groups"):
        return "conflict", f"intake review group(s): {rec['review_groups']}"
    return None


def select_candidates(intake: Any, seeds: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Splits intake records into (eligible, skipped). Every record lands in exactly one list; skipped keep the
    whole original record and a reason."""
    if not isinstance(intake, dict) or not isinstance(intake.get("records"), list):
        raise IntakeError("intake report has no records list (expected company_sheet_intake intake_report.json)")
    records = intake["records"]
    rows = Counter(r.get("source_row") for r in records if isinstance(r, dict) and _is_row(r.get("source_row")))
    eligible: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    def skip(rec: Any, kind: str, reason: str) -> None:
        row = rec.get("source_row") if isinstance(rec, dict) else None
        company = rec.get("company") if isinstance(rec, dict) else None
        skipped.append({"source_row": row, "company": company, "skip_kind": kind, "reason": reason, "record": rec})

    for rec in records:
        if not isinstance(rec, dict):
            skip(rec, "malformed_record", "record is not an object")
            continue
        problem = _record_problem(rec, rows)
        if problem:
            skip(rec, *problem)
            continue
        ats, token = rec["ats_candidate"], rec["identifiers"]["token"]
        eligible.append({"board_id": board_id(ats, token), "ats": ats, "token": token, "url": request_url(ats, token),
                         "source_row": rec["source_row"], "company": rec["company"].strip(),
                         "record_sha256": record_sha256(rec), "record": rec})

    # Cross-record checks: one board claimed by several rows is a conflict; an existing seed is already covered.
    by_board: dict[str, list[dict[str, Any]]] = {}
    for e in eligible:
        by_board.setdefault(e["board_id"].casefold(), []).append(e)
    seeded = existing_boards(seeds)
    kept = []
    for e in eligible:
        key = e["board_id"].casefold()
        if len(by_board[key]) > 1:
            rows_ = [x["source_row"] for x in by_board[key]]
            skip(e["record"], "duplicate_board", f"board {e['board_id']} appears on rows {rows_}; not resolved automatically")
        elif key in seeded:
            skip(e["record"], "already_seeded", f"board {e['board_id']} is already in company_seeds.json as slug {seeded[key].get('slug')!r}")
        else:
            kept.append(e)
    assert len(kept) + len(skipped) == len(records)
    return kept, skipped


PLAN_FIELDS = ("board_id", "ats", "token", "url", "source_row", "company", "record_sha256")


def build_plan(intake: Any, seeds: dict[str, Any], intake_path: str | None = None) -> dict[str, Any]:
    eligible, skipped = select_candidates(intake, seeds)
    return {
        "kind": "board_verification_request_plan",
        "note": "Plan only. No request was made. Each entry is one GET to the connector's own endpoint.",
        "intake": intake_path,
        "requests_made": 0,
        "approved_hosts": sorted(APPROVED_HOSTS),
        "counts": {"intake_records": len(intake["records"]), "planned": len(eligible), "skipped": len(skipped)},
        "planned": [{k: e[k] for k in PLAN_FIELDS} for e in eligible],
        "skipped": skipped,
    }


def _text(v: Any, limit: int) -> bool:
    return isinstance(v, str) and bool(v.strip()) and len(v) <= limit and not re.search(r"[\x00-\x08\x0b-\x1f\x7f]", v)


def _job_id(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return v > 0
    return _text(v, 200)


def safe_job_url(v: Any) -> bool:
    """An application URL a user may be sent to: https, a valid host, no credentials, port, spaces or controls."""
    if not isinstance(v, str) or len(v) > 2048 or _CONTROL_RE.search(v):
        return False
    try:
        parts = urlsplit(v)
        port = parts.port
    except ValueError:
        return False
    host = parts.hostname or ""
    labels = host.split(".")
    return (parts.scheme == "https" and port is None and not parts.username and not parts.password
            and len(labels) >= 2 and all(_LABEL_RE.match(x) for x in labels) and not labels[-1].isdigit())


def posting_problem(ats: str, item: Any) -> str | None:
    """Why a posting is not usable by the connector (same fields it reads, checked for type and safety), else None."""
    if not isinstance(item, dict):
        return "posting is not an object"
    g = item.get
    if ats == "greenhouse":
        job_id, title, url = g("id"), g("title"), g("absolute_url")
    elif ats == "lever":
        job_id, title, url = g("id"), g("text"), g("hostedUrl") or g("applyUrl")
    elif ats == "ashby":
        job_id, title, url = g("id") or g("jobUrl"), g("title"), g("jobUrl") or g("applyUrl")
    else:  # smartrecruiters: the connector builds the apply URL from token and id itself
        job_id, title, url = g("id") or g("uuid"), g("name"), None
    if not _job_id(job_id):
        return "id missing or not a positive integer / non-empty string"
    if not _text(title, 500):
        return "title missing or not a non-empty string"
    if ats != "smartrecruiters" and not safe_job_url(url):
        return "application url missing or not a safe https url"
    return None


def classify(ats: str, status: int, body: bytes) -> dict[str, Any]:
    """Outcome for one response. A rate limit, server error or bad payload is never evidence the board is dead."""
    base = {"http_status": status, "raw_postings": None, "usable_postings": None, "unusable_reasons": None}
    if status == 404:
        return {**base, "outcome": NOT_FOUND, "board_exists": False, "detail": "404 from the connector endpoint"}
    if status == 429:
        return {**base, "outcome": RATE_LIMITED, "board_exists": None, "detail": "429: says nothing about the board"}
    if status >= 500:
        return {**base, "outcome": SERVER_ERROR, "board_exists": None, "detail": f"{status}: temporary, not proof of a dead board"}
    if status != 200:
        return {**base, "outcome": HTTP_ERROR, "board_exists": None, "detail": f"unexpected HTTP {status}"}
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return {**base, "outcome": MALFORMED, "board_exists": None, "detail": "200 but body is not JSON"}
    key = CONNECTORS[ats]["list_key"]
    items = payload if key is None else (payload.get(key) if isinstance(payload, dict) else None)
    if not isinstance(items, list):
        # Stricter than the connector (which treats a missing list as empty): a wrong shape is never "empty".
        want = "a JSON list" if key is None else f"an object with a {key!r} list"
        return {**base, "outcome": MALFORMED, "board_exists": None, "detail": f"200 but payload is not {want}"}
    reasons = Counter(p for p in (posting_problem(ats, i) for i in items) if p)
    usable = len(items) - sum(reasons.values())
    outcome = VALID_WITH_JOBS if usable else VALID_EMPTY
    detail = f"{usable} of {len(items)} postings have valid, safe connector fields"
    if outcome == VALID_EMPTY and ats == "smartrecruiters":
        detail += "; SmartRecruiters may answer 200 with no postings for an unknown company, so empty is not proof it exists"
    return {**base, "outcome": outcome, "board_exists": True if usable else None, "raw_postings": len(items),
            "usable_postings": usable, "unusable_reasons": dict(reasons) or None, "detail": detail}


async def verify_board(client: httpx.AsyncClient, item: dict[str, Any], *, evidence: str) -> dict[str, Any]:
    """One GET, no retries. The URL is rebuilt from ats/token and must equal the planned URL, so an edited plan
    can never send a request anywhere else."""
    head = {k: item.get(k) for k in PLAN_FIELDS}
    head["evidence"] = evidence
    empty = {"board_exists": None, "http_status": None, "raw_postings": None, "usable_postings": None, "unusable_reasons": None}
    try:
        if evidence not in EVIDENCE_KINDS:
            raise ValueError(f"evidence must be one of {EVIDENCE_KINDS}")
        url = request_url(item.get("ats"), item.get("token"))
        if item.get("url") != url or item.get("board_id") != board_id(item["ats"], item["token"]):
            raise ValueError("plan entry url/board_id do not match its ats and token")
    except (ValueError, KeyError, TypeError) as exc:
        return {**head, **empty, "outcome": REJECTED, "detail": str(exc)}
    try:
        resp = await client.get(url, headers={"Accept": "application/json"})
    except httpx.TransportError as exc:
        return {**head, **empty, "outcome": TRANSPORT_ERROR, "detail": f"{type(exc).__name__}: not proof of a dead board"}
    return {**head, **classify(item["ats"], resp.status_code, resp.content)}


async def verify_plan(client: httpx.AsyncClient, planned: list[dict[str, Any]], *, evidence: str) -> list[dict[str, Any]]:
    return [await verify_board(client, item, evidence=evidence) for item in planned]  # sequential: one request at a time


def fixture_transport(responses: dict[str, Any]) -> httpx.MockTransport:
    """Serves local fixture responses by exact URL. Any URL without a fixture fails as a transport error.
    Fixture entry: {"status": int, "json": any} | {"status": int, "body": str} | {"transport_error": str}."""
    def handle(request: httpx.Request) -> httpx.Response:
        spec = responses.get(str(request.url))
        if not isinstance(spec, dict) or "transport_error" in spec:
            raise httpx.ConnectError((spec or {}).get("transport_error", "no fixture for this url"), request=request)
        if "json" in spec:
            return httpx.Response(int(spec.get("status", 200)), json=spec["json"])
        return httpx.Response(int(spec.get("status", 200)), content=str(spec.get("body", "")).encode())
    return httpx.MockTransport(handle)


async def verify_with_fixtures(planned: list[dict[str, Any]], responses: dict[str, Any]) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(transport=fixture_transport(responses)) as client:
        return await verify_plan(client, planned, evidence=SYNTHETIC)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--intake", required=True, type=Path, help="company_sheet_intake intake_report.json")
    p.add_argument("--out-dir", required=True, type=Path)
    p.add_argument("--seeds", type=Path, default=DEFAULT_SEEDS_PATH, help="read only; used to skip boards already seeded")
    p.add_argument("--fixture-responses", type=Path, help="local fixture JSON {url: response}; offline, synthetic only")
    a = p.parse_args(argv)
    try:
        intake = load_json(a.intake)
        plan = build_plan(intake, load_json(a.seeds), str(a.intake))
        responses = load_json(a.fixture_responses) if a.fixture_responses else None
        if responses is not None and not isinstance(responses, dict):
            raise IntakeError("fixture responses must be an object keyed by url")
    except (IntakeError, FileNotFoundError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    a.out_dir.mkdir(parents=True, exist_ok=True)
    (a.out_dir / "request_plan.json").write_text(json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(plan["counts"]))
    if responses is not None:
        results = asyncio.run(verify_with_fixtures(plan["planned"], responses))
        out = {"kind": "board_verification_results", "evidence": SYNTHETIC, "test_only": True,
               "note": "SYNTHETIC FIXTURE RESULTS: no live request was made; not evidence about any real board.",
               "results": results}
        (a.out_dir / "verification_results.json").write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
