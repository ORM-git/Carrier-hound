"""Row 34 offline audit: which company names are mapped only by the prefix fallback of
normalize_company_alias (scripts/scraper/enrichment.py:791-793).

Files only: scripts/scraper/company_seeds.json and data/ats-candidates-all.json. No database, no network.
The real function is called twice per name: once as-is, and once with the prefix loop disabled (a recording
alias map whose items() is empty; exact lookups still work). A different result means the prefix branch fired;
the recorder holds the alias key it stopped on. No normalization logic is copied here.

Run: python -m scripts.scraper.audit_alias_prefix [--json]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Iterable

from scripts.scraper import enrichment

ROOT = Path(__file__).resolve().parents[2]
SEEDS = ROOT / "scripts" / "scraper" / "company_seeds.json"
ATS_CANDIDATES = ROOT / "data" / "ats-candidates-all.json"


class _AliasRecorder(dict):
    """Same lookups as the alias dict; items() is empty when prefix=False, else records the last key yielded."""

    def __init__(self, base: dict, prefix: bool) -> None:
        super().__init__(base)
        self.prefix = prefix
        self.last_key: str | None = None

    def items(self):  # type: ignore[override]
        if not self.prefix:
            return iter(())

        def walk():
            for key, value in dict.items(self):
                self.last_key = key
                yield key, value

        return walk()


def _call(name: str, aliases: _AliasRecorder) -> tuple:
    saved = enrichment.COMPANY_ALIASES
    enrichment.COMPANY_ALIASES = aliases
    try:
        return enrichment.normalize_company_alias(name)
    finally:
        enrichment.COMPANY_ALIASES = saved


def prefix_match(name: str, aliases: dict | None = None) -> dict[str, Any] | None:
    """The prefix-only mapping for `name` ({alias_key, inherited}), or None if exact lookup or nothing maps it."""
    base = enrichment.COMPANY_ALIASES if aliases is None else aliases
    full = _AliasRecorder(base, prefix=True)
    real = _call(name, full)
    exact_only = _call(name, _AliasRecorder(base, prefix=False))
    if real == exact_only:
        return None
    return {"alias_key": full.last_key, "inherited": {"name": real[0], "category": real[1], "domain": real[2]}}


def load_names(seeds_path: Path = SEEDS, ats_path: Path = ATS_CANDIDATES) -> list[tuple[str, str]]:
    """(name, origin) for every company name and seed slug in the two files, first origin kept per name."""
    out: dict[str, str] = {}

    def add(values: Iterable[Any], origin: str) -> None:
        for v in values:
            if isinstance(v, str) and v.strip() and v not in out:
                out[v] = origin

    seeds = json.loads(seeds_path.read_text(encoding="utf-8"))
    layer1 = seeds.get("layer1_public_ats") or []
    layer2 = seeds.get("layer2_enterprise_json") or {}
    workday = layer2.get("workday_cxs") or []
    singles = [v for k, v in layer2.items() if k != "workday_cxs" and isinstance(v, dict)]
    for label, rows in (("seeds:layer1", layer1), ("seeds:workday", workday), ("seeds:layer2", singles)):
        add((r.get("name") for r in rows if isinstance(r, dict)), f"{label}:name")
        # enrichment.py:814 also passes seed slugs through normalize_company_alias
        add((r.get("slug") for r in rows if isinstance(r, dict)), f"{label}:slug")
    ats = json.loads(ats_path.read_text(encoding="utf-8"))
    add((r.get("company") for r in ats if isinstance(r, dict)), "ats-candidates:company")
    return list(out.items())


def audit(names: list[tuple[str, str]]) -> list[dict[str, Any]]:
    hits = []
    for name, origin in names:
        m = prefix_match(name)
        if m:
            hits.append({"name": name, "origin": origin, **m})
    return hits


def main(argv: list[str]) -> int:
    names = load_names()
    hits = audit(names)
    if "--json" in argv:
        print(json.dumps({"names_checked": len(names), "prefix_only_matches": hits}, indent=2, ensure_ascii=False))
        return 0
    print(f"names checked: {len(names)}  prefix-only matches: {len(hits)}")
    for h in hits:
        print(f"{h['alias_key']:<20} -> {h['inherited']['name']:<24} <- {h['name']!r} ({h['origin']})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
