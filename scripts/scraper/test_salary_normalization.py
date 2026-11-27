import asyncio
import json
import re
import unittest
from pathlib import Path

import httpx

from scripts.scraper.engine import SupabaseSetDiffWriter
from scripts.scraper.fetchers import _greenhouse_salary, _lever_salary_period, build_normalized_job
from scripts.scraper.salary_normalization import ANNUALIZATION, salary_normalization_columns

TS_NORMALIZE = Path(__file__).resolve().parents[2] / "src/lib/salary/normalize.ts"
SEED = {"name": "Acme", "slug": "acme", "ats": "lever", "token": "acme"}


def _job(**kw):
    return build_normalized_job(seed=SEED, source="lever", source_type="lever", source_job_id="acme:1",
                                title="Engineer", location="Berlin, Germany", apply_url="https://jobs.lever.co/acme/1", **kw)


def _gh(blurb=None, currency="USD"):
    return _greenhouse_salary({"pay_input_ranges": [{"min_cents": 5000, "max_cents": 6000, "currency_type": currency,
                                                     "title": "Pay", "blurb": blurb}]})


class TestAnnualizationDrift(unittest.TestCase):
    def test_factors_match_ts(self) -> None:
        text = TS_NORMALIZE.read_text(encoding="utf-8")
        block = re.search(r"ANNUALIZATION_FACTORS[^{]*\{(.*?)\n\};", text, re.S).group(1)
        ts = {p: (int(f), a == "true") for p, f, a in re.findall(r"(\w+): \{ factor: (\d+), conversionAssumed: (true|false) \}", block)}
        for period, rule in ANNUALIZATION.items():
            self.assertEqual(ts[period], rule, period)


class TestStatedMatrix(unittest.TestCase):
    def test_lever_native_interval(self) -> None:
        cases = {"per-year-salary": "yearly", "per-month-salary": "monthly", "per-hour-wage": "hourly",
                 "per-day-wage": None, "per-week-salary": None, "one-time": None, "": None, None: None}
        for raw, want in cases.items():
            self.assertEqual(_lever_salary_period(raw), want, raw)

    def test_greenhouse_pay_range_text(self) -> None:
        self.assertEqual((_gh("$50 per hour")["salary_period"], _gh("$50 per hour")["salary_period_stated"]), ("hourly", True))
        for blurb in (None, "$400 per day", "paid weekly", "annual base"):  # annual: Python never reads yearly from text
            self.assertEqual((_gh(blurb)["salary_period"], _gh(blurb)["salary_period_stated"]), (None, False), blurb)
        self.assertFalse(_gh()["salary_period_stated"])  # "/yr" in salary_text is a display default, not evidence

    def test_build_job_flag_needs_salary_and_period(self) -> None:
        self.assertTrue(_job(salary_min=100000.0, salary_period="yearly", salary_period_stated=True)["salary_period_stated"])
        self.assertFalse(_job(salary_min=100000.0, salary_period="yearly")["salary_period_stated"])  # default: unstated
        self.assertFalse(_job(salary_min=100000.0, salary_period_stated=True)["salary_period_stated"])  # no period
        self.assertFalse(_job(salary_period="yearly", salary_period_stated=True)["salary_period_stated"])  # no salary


class TestColumns(unittest.TestCase):
    def test_stated_periods_annualize(self) -> None:
        self.assertEqual(salary_normalization_columns({"salary_min": 5000, "salary_max": 6000, "salary_period": "monthly", "salary_period_stated": True}),
                         {"salary_annual_min": 60000, "salary_annual_max": 72000, "salary_period_inferred": False, "salary_conversion_assumed": False})
        self.assertEqual(salary_normalization_columns({"salary_min": 50, "salary_period": "hourly", "salary_period_stated": True}),
                         {"salary_annual_min": 104000, "salary_annual_max": None, "salary_period_inferred": False, "salary_conversion_assumed": True})

    def test_unstated_or_invalid_never_annualize(self) -> None:
        none = {"salary_annual_min": None, "salary_annual_max": None, "salary_conversion_assumed": None}
        for job, inferred in [
            ({"salary_min": 120000, "salary_period": "yearly"}, True),                                   # stored period, unstated
            ({"salary_min": 300, "salary_period": "daily", "salary_period_stated": True}, False),        # not storable here
            ({"salary_min": 9, "salary_max": 5, "salary_period": "yearly", "salary_period_stated": True}, False),  # min > max
            ({"salary_min": float("nan"), "salary_period": "yearly", "salary_period_stated": True}, False),
            ({}, None),
        ]:
            out = salary_normalization_columns(job)
            self.assertEqual({k: out[k] for k in none}, none, job)
            self.assertEqual(out["salary_period_inferred"], inferred, job)

    def test_no_scale_override(self) -> None:
        # The Python path has no amount-based period guess: a large stated hourly figure stays hourly.
        out = salary_normalization_columns({"salary_min": 900, "salary_period": "hourly", "salary_period_stated": True})
        self.assertEqual(out["salary_annual_min"], 900 * 2080)


class TestWriterProbe(unittest.TestCase):
    def _run(self, probe_status: int) -> dict:
        posted: list = []

        def handler(request: httpx.Request) -> httpx.Response:
            if "salary_annual_min" in str(request.url):
                return httpx.Response(probe_status, json=[])
            if request.method == "POST":
                rows = json.loads(request.content)
                posted.extend(rows)
                return httpx.Response(201, json=[{**r, "id": f"id-{i}"} for i, r in enumerate(rows)])
            return httpx.Response(200, json=[])

        job = {"source_type": "lever", "source_id": "lever:acme", "source_job_id": "acme:1", "source_priority": 1,
               "company": "Acme", "company_slug": "acme", "title": "Engineer", "apply_url": "https://jobs.lever.co/acme/1",
               "salary_min": 5000.0, "salary_period": "monthly", "salary_period_stated": True}

        async def run():
            writer = SupabaseSetDiffWriter("https://unit-test-project.supabase.co", "fake-key")
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                await writer.sync_jobs_set_diff(client, [job], {})

        asyncio.run(run())
        self.assertEqual(len(posted), 1)
        return posted[0]

    def test_columns_written_only_when_probe_finds_them(self) -> None:
        with_cols = self._run(200)
        self.assertEqual((with_cols["salary_annual_min"], with_cols["salary_period_inferred"]), (60000.0, False))
        without = self._run(400)
        self.assertFalse(any(k in without for k in ("salary_annual_min", "salary_period_inferred")))
        self.assertNotIn("salary_period_stated", with_cols)  # internal flag, never a DB column


if __name__ == "__main__":
    unittest.main()
