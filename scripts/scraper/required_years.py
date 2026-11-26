"""Required experience years from a job posting's text.

Python port of src/lib/jobs/requiredYears.ts. Both implementations must return the same bounds for every
case in src/lib/jobs/__tests__/fixtures/required-years-cases.json (each suite reads that one file).

Bounds need positive, scoped work-experience evidence. Company age, candidate age and negated text give
none; ambiguous, conflicting or invalid text gives (None, None). min set + max None means "N+";
min None + max set means an inclusive upper bound ("up to N").
"""
from __future__ import annotations

import re
from typing import Optional, Tuple

REQUIRED_YEARS_SOURCE_DESCRIPTION = "description"
MAX_YEARS = 40

_F = re.IGNORECASE | re.ASCII
# JS \s also matches NBSP and other unicode spaces; spell the class out so re.ASCII does not change it.
_S = r"[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]"
_YEARS = r"(?:years?|yrs?)"
# A complete token: not glued to a preceding digit or dot ("12.25" is not "25", "100.5" is not "5").
_N = r"(?<![0-9.])([0-9]{1,2}(?:\.[0-9])?)"
_DASH = r"(?:-|\u2013|\u2014|to)"

# Range ends are matched as WHOLE numeric tokens of any length, then validated: an unsupported end ("2.75-4",
# "12.25-15", "0.25 to 2") makes the whole range invalid, never a lone minimum from its valid end.
_GEN = r"(?<![0-9.])([0-9]+(?:\.[0-9]+)?)"
_GEN2 = r"([0-9]+(?:\.[0-9]+)?)"
_STRICT_TOKEN = re.compile(r"^[0-9]{1,2}(?:\.[0-9])?$")
_RANGE = re.compile(rf"\b{_GEN}{_S}*{_DASH}{_S}*{_GEN2}{_S}*\+?{_S}*{_YEARS}", _F)
_MIN_ONLY = [
    re.compile(rf"\b{_N}{_S}*\+{_S}*{_YEARS}", _F),
    re.compile(rf"\b{_N}{_S}*or{_S}+more{_S}+{_YEARS}", _F),
    re.compile(rf"\b(?:at{_S}+least|minimum(?:{_S}+of)?|min\.?){_S}+{_N}{_S}*\+?{_S}*{_YEARS}", _F),
    re.compile(rf"\b{_N}{_S}*{_YEARS}", _F),
]
_NEGATIVE_AMOUNT = re.compile(
    rf"(?<![A-Za-z0-9_.])[-\u2212]{_GEN2}(?:{_S}*{_DASH}{_S}*{_GEN2})?{_S}*\+?{_S}*(?:or{_S}+more{_S}+)?{_YEARS}", _F
)
_UPPER_PREFIX = re.compile(
    rf"\b(?:up{_S}+to|at{_S}+most|maximum(?:{_S}+of)?|max\.?|no{_S}+more{_S}+than|not{_S}+more{_S}+than|less{_S}+than|fewer{_S}+than|under|below){_S}*$",
    _F,
)
_SIGN_BEFORE = re.compile(r"(?:^|[^A-Za-z0-9_.])[-\u2212]$")
_UPPER_INCLUSIVE = re.compile(
    rf"\b(?:up{_S}+to|at{_S}+most|maximum(?:{_S}+of)?|max\.?|no{_S}+more{_S}+than|not{_S}+more{_S}+than){_S}+{_N}{_S}*(\+)?{_S}*{_YEARS}",
    _F,
)
_UPPER_STRICT = re.compile(rf"\b(?:less{_S}+than|fewer{_S}+than|under|below){_S}+{_N}{_S}*\+?{_S}*{_YEARS}", _F)
_UPPER_NEGATION_WORDS = re.compile(rf"\b(?:no|not){_S}+more{_S}+than\b", _F)

_CLAUSE_SPLIT = re.compile(r"(?:(?<!\bmax)(?<!\bmin)[.!?](?![0-9])|[;\n\u2022])+|\b(?:but|however|whereas)\b", _F)
_EXPERIENCE_CUE = re.compile(r"\bexperien(?:ce|ced)\b|\bexp\b|\bhands[- ]on\b", _F)
_NEGATION = re.compile(r"\b(?:no|not|without|never|none)\b|n't\b", _F)
_COMPANY_CUE = re.compile(
    r"\b(?:we've|we have|we've been|our (?:company|firm|team has|history)|founded|established|serving|in business|track record|history)\b",
    _F,
)
_AGE_AFTER = re.compile(r"^\s*(?:old\b|of\s+age\b)", _F)

Bounds = Tuple[Optional[float], Optional[float]]


def _num(v: float) -> float | int:
    return int(v) if float(v).is_integer() else v


def extract_required_years(text: Optional[str]) -> Optional[Bounds]:
    """(min, max) required years, or None when the text gives no single unambiguous requirement."""
    if not text or not isinstance(text, str):
        return None
    accepted: dict = {}
    blocked = False

    for raw in _CLAUSE_SPLIT.split(text):
        clause = (raw or "").strip()
        if not clause:
            continue
        scoped = bool(_EXPERIENCE_CUE.search(clause))
        negated = bool(_NEGATION.search(_UPPER_NEGATION_WORDS.sub(" ", clause)))

        def classify(m, lo, hi, forced):
            after = clause[m.end():]
            if _AGE_AFTER.search(after) or not scoped:
                return "not_experience"
            if negated:
                return "negated"
            if _COMPANY_CUE.search(clause):
                return "ambiguous"
            if forced:
                return forced
            bad = lambda v: v is not None and (v < 0 or v > MAX_YEARS)
            if (lo is None and hi is None) or bad(lo) or bad(hi) or (lo is not None and hi is not None and hi < lo):
                return "invalid"
            return "requirement"

        def record(m, lo, hi, forced=None):
            nonlocal blocked
            status = classify(m, lo, hi, forced)
            if status in ("negated", "ambiguous", "invalid"):
                blocked = True
            if status == "requirement":
                accepted[(lo, hi)] = (lo, hi)

        rest = clause

        def run(pattern, fn):
            nonlocal rest
            for m in list(pattern.finditer(rest)):
                fn(m)
            rest = pattern.sub(lambda x: " " * len(x.group(0)), rest)

        def guard(m):
            b = clause[: m.start()]
            if _SIGN_BEFORE.search(b):
                return "invalid"
            if _UPPER_PREFIX.search(b):
                return "ambiguous"
            return None

        run(_NEGATIVE_AMOUNT, lambda m: record(m, None, None, "invalid"))
        run(
            _RANGE,
            lambda m: record(m, float(m.group(1)), float(m.group(2)), guard(m))
            if _STRICT_TOKEN.match(m.group(1)) and _STRICT_TOKEN.match(m.group(2))
            else record(m, None, None, "invalid"),
        )
        run(_UPPER_INCLUSIVE, lambda m: record(m, None, float(m.group(1)), "ambiguous" if m.group(2) else None))
        run(_UPPER_STRICT, lambda m: record(m, None, None, "ambiguous"))
        for pat in _MIN_ONLY:
            run(pat, lambda m: record(m, float(m.group(1)), None, guard(m)))

    if blocked or len(accepted) != 1:
        return None
    lo, hi = next(iter(accepted.values()))
    return (None if lo is None else _num(lo), None if hi is None else _num(hi))
