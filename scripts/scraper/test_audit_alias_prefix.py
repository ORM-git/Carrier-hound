import unittest

from scripts.scraper import enrichment
from scripts.scraper.audit_alias_prefix import prefix_match

FIXTURE = {
    "acmecorp": ("Acme Corp", "OTHER_STARTUPS", "acme.com"),
    "abc": ("ABC", "OTHER_STARTUPS", "abc.com"),  # under 5 chars: never prefix-matched
}


class TestAliasPrefixAudit(unittest.TestCase):
    def test_unrelated_prefix_is_no_longer_mapped(self) -> None:
        self.assertIsNone(prefix_match("Acmecorp Logistics", FIXTURE))

    def test_exact_match_and_no_match_are_not_flagged(self) -> None:
        self.assertIsNone(prefix_match("Acme Corp", FIXTURE))      # exact token "acmecorp"
        self.assertIsNone(prefix_match("Globex", FIXTURE))         # no alias at all
        self.assertIsNone(prefix_match("abcdef", FIXTURE))         # short key: prefix branch skips it

    def test_real_alias_table_is_restored(self) -> None:
        before = enrichment.COMPANY_ALIASES
        prefix_match("Acmecorp Logistics", FIXTURE)
        self.assertIs(enrichment.COMPANY_ALIASES, before)


if __name__ == "__main__":
    unittest.main()
