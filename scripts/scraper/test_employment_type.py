import re
import unittest
from pathlib import Path

from scripts.scraper.fetchers import _EMPLOYMENT_SYNONYMS, build_normalized_job, map_employment_type

TS_MAPPER = Path(__file__).resolve().parents[2] / "src/lib/jobs/employmentTypeMap.ts"


def _job(**kw):
    seed = {"name": "Acme", "slug": "acme", "ats": "lever", "token": "acme"}
    return build_normalized_job(seed=seed, source="lever", source_type="lever", source_job_id="acme:1",
                                title=kw.pop("title", "Software Engineer"), location="Berlin, Germany",
                                apply_url="https://jobs.lever.co/acme/1", **kw)


class TestEmploymentType(unittest.TestCase):
    def test_synonyms_match_ts_mapper(self) -> None:
        block = re.search(r"const SYNONYMS[^{]*\{(.*?)\};", TS_MAPPER.read_text(encoding="utf-8"), re.S).group(1)
        ts = {k or k2: v for k, k2, v in re.findall(r'(?:"([^"]+)"|([\w-]+)):\s*"([^"]+)"', block)}
        self.assertEqual(ts, _EMPLOYMENT_SYNONYMS)

    def test_conservative_mapping(self) -> None:
        cases = {"Full-time": "full-time", "  Full   Time ": "full-time", "Permanent": "full-time",
                 "Part time": "part-time", "Contractor": "contract", "Intern": "internship",
                 "Full-time or Contract": "other", "Temporary": "other", "constructor": "other", "": "other", None: "other"}
        for raw, want in cases.items():
            self.assertEqual(map_employment_type(raw), want, raw)

    def test_structured_field_wins_over_title_guess(self) -> None:
        self.assertEqual(_job(employment_type="Contract")["job_type"], "contract")
        self.assertEqual(_job(employment_type="Part time")["job_type"], "part-time")
        self.assertEqual(_job(title="Software Intern", employment_type="Full time")["job_type"], "full-time")

    def test_absent_field_keeps_legacy_fallback(self) -> None:
        self.assertEqual(_job()["job_type"], "full-time")
        self.assertEqual(_job(employment_type="  ")["job_type"], "full-time")
        self.assertEqual(_job(title="Data Intern")["job_type"], "internship")


if __name__ == "__main__":
    unittest.main()
