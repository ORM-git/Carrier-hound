"""Board verification planning for company-sheet ATS candidates (Greenhouse, Lever, Ashby, SmartRecruiters).

Input: the intake_report.json written by company_sheet_intake (PR #882). Only clean, unambiguous candidates with a
connector-compatible board token are planned; every other record is kept with its reason.

  # default: write request_plan.json only. ZERO network requests.
  python -m scripts.scraper.board_verify --intake out/intake/intake_report.json --out-dir out/verify

  # offline replay of local fixture responses through an httpx MockTransport (still zero network); results are
  # marked evidence="synthetic_fixture" and can never qualify a production seed.
  python -m scripts.scraper.board_verify --intake ... --out-dir ... --fixture-responses fixtures.json

There is deliberately no live-network option. verify_plan() takes an injected client so a later, separately
reviewed stage can supply a real one.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

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
# Stricter than the intake's token pattern: no '%' or '~', so a token can never encode a path or another host.
TOKEN_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$")

SYNTHETIC = "synthetic_fixture"
LIVE = "live"
EVIDENCE_KINDS = (SYNTHETIC, LIVE)

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


def request_url(ats: str, token: Any) -> str:
    """The connector's URL for this board. Raises ValueError for an unknown ATS, a bad token or a non-approved host."""
    if ats not in CONNECTORS:
        raise ValueError(f"no connector for ats {ats!r}")
    if not isinstance(token, str) or not TOKEN_RE.match(token):
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


def select_candidates(intake: Any, seeds: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Splits intake records into (eligible, skipped). Every record lands in exactly one list; skipped keep the
    whole original record and a reason."""
    if not isinstance(intake, dict) or not isinstance(intake.get("records"), list):
        raise IntakeError("intake report has no records list (expected company_sheet_intake intake_report.json)")
    eligible: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    def skip(rec: Any, kind: str, reason: str) -> None:
        row = rec.get("source_row") if isinstance(rec, dict) else None
        company = rec.get("company") if isinstance(rec, dict) else None
        skipped.append({"source_row": row, "company": company, "skip_kind": kind, "reason": reason, "record": rec})

    for rec in intake["records"]:
        if not isinstance(rec, dict):
            skip(rec, "malformed_record", "record is not an object")
            continue
        company = rec.get("company")
        ats = rec.get("ats_candidate")
        ids = rec.get("identifiers")
        if rec.get("merged_into_row") is not None:
            skip(rec, "merged_duplicate", f"intake merged this row into row {rec['merged_into_row']}")
        elif not isinstance(company, str) or not company.strip():
            skip(rec, "missing_company", "company name blank or missing")
        elif rec.get("status") != "ats_candidate":
            skip(rec, "not_candidate", f"intake status {rec.get('status')!r}: {rec.get('reason')}")
        elif ats not in CONNECTORS:
            skip(rec, "out_of_scope_ats", f"ats {ats!r} is not verified in this stage (greenhouse/lever/ashby/smartrecruiters only)")
        elif not isinstance(ids, dict) or set(ids) != {"token"}:
            skip(rec, "invalid_identifier", f"identifiers {ids!r} are not exactly {{'token': ...}}")
        elif not isinstance(ids["token"], str) or not TOKEN_RE.match(ids["token"]):
            skip(rec, "invalid_identifier", f"token {ids['token']!r} is not connector-compatible")
        elif rec.get("review_groups"):
            skip(rec, "conflict", f"intake review group(s): {rec['review_groups']}")
        else:
            token = ids["token"]
            eligible.append({"board_id": board_id(ats, token), "ats": ats, "token": token, "url": request_url(ats, token),
                             "source_row": rec.get("source_row"), "company": company.strip(), "record": rec})

    # Cross-record checks: one board claimed by several rows is a conflict; an existing seed is already covered.
    by_board: dict[str, list[dict[str, Any]]] = {}
    for e in eligible:
        by_board.setdefault(e["board_id"].casefold(), []).append(e)
    seeded = existing_boards(seeds)
    kept = []
    for e in eligible:
        key = e["board_id"].casefold()
        if len(by_board[key]) > 1:
            rows = [x["source_row"] for x in by_board[key]]
            skip(e["record"], "duplicate_board", f"board {e['board_id']} appears on rows {rows}; not resolved automatically")
        elif key in seeded:
            skip(e["record"], "already_seeded", f"board {e['board_id']} is already in company_seeds.json as slug {seeded[key].get('slug')!r}")
        else:
            kept.append(e)
    assert len(kept) + len(skipped) == len(intake["records"])
    return kept, skipped


def build_plan(intake: Any, seeds: dict[str, Any], intake_path: str | None = None) -> dict[str, Any]:
    eligible, skipped = select_candidates(intake, seeds)
    return {
        "kind": "board_verification_request_plan",
        "note": "Plan only. No request was made. Each entry is one GET to the connector's own endpoint.",
        "intake": intake_path,
        "requests_made": 0,
        "approved_hosts": sorted(APPROVED_HOSTS),
        "counts": {"intake_records": len(intake["records"]), "planned": len(eligible), "skipped": len(skipped)},
        "planned": [{k: e[k] for k in ("board_id", "ats", "token", "url", "source_row", "company")} for e in eligible],
        "skipped": skipped,
    }


def _usable(ats: str, item: Any) -> bool:
    """The same fields the connector requires before it emits a job (fetchers.fetch_*)."""
    if not isinstance(item, dict):
        return False
    g = item.get
    if ats == "greenhouse":
        return bool(g("id") and g("title") and g("absolute_url"))
    if ats == "lever":
        return bool(g("id") and g("text") and (g("hostedUrl") or g("applyUrl")))
    if ats == "ashby":
        return bool((g("id") or g("jobUrl")) and g("title") and (g("jobUrl") or g("applyUrl")))
    return bool((g("id") or g("uuid")) and g("name"))  # smartrecruiters


def classify(ats: str, status: int, body: bytes) -> dict[str, Any]:
    """Outcome for one response. A rate limit, server error or bad payload is never evidence the board is dead."""
    base = {"http_status": status, "raw_postings": None, "usable_postings": None}
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
    usable = sum(1 for i in items if _usable(ats, i))
    outcome = VALID_WITH_JOBS if usable else VALID_EMPTY
    detail = f"{usable} of {len(items)} postings have the fields the connector needs"
    if outcome == VALID_EMPTY and ats == "smartrecruiters":
        detail += "; SmartRecruiters may answer 200 with no postings for an unknown company, so empty is not proof it exists"
    return {**base, "outcome": outcome, "board_exists": True if usable else None, "raw_postings": len(items),
            "usable_postings": usable, "detail": detail}


async def verify_board(client: httpx.AsyncClient, item: dict[str, Any], *, evidence: str) -> dict[str, Any]:
    """One GET, no retries. The URL is rebuilt from ats/token and must equal the planned URL, so an edited plan
    can never send a request anywhere else."""
    head = {k: item.get(k) for k in ("board_id", "ats", "token", "url", "source_row", "company")}
    head["evidence"] = evidence
    try:
        if evidence not in EVIDENCE_KINDS:
            raise ValueError(f"evidence must be one of {EVIDENCE_KINDS}")
        url = request_url(item.get("ats"), item.get("token"))
        if item.get("url") != url or item.get("board_id") != board_id(item["ats"], item["token"]):
            raise ValueError("plan entry url/board_id do not match its ats and token")
    except (ValueError, KeyError, TypeError) as exc:
        return {**head, "outcome": REJECTED, "board_exists": None, "http_status": None, "raw_postings": None,
                "usable_postings": None, "detail": str(exc)}
    try:
        resp = await client.get(url, headers={"Accept": "application/json"})
    except httpx.TransportError as exc:
        return {**head, "outcome": TRANSPORT_ERROR, "board_exists": None, "http_status": None, "raw_postings": None,
                "usable_postings": None, "detail": f"{type(exc).__name__}: not proof of a dead board"}
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
