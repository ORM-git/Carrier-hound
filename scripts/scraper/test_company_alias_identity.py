"""Real normalizer guards. Synthetic unrelated names are not production incidents."""
import unittest
from scripts.scraper.enrichment import COMPANY_ALIASES, normalize_company_alias


class CompanyAliasIdentityTests(unittest.TestCase):
    def test_every_explicit_alias_retains_its_identity(self):
        for alias, identity in COMPANY_ALIASES.items():
            with self.subTest(alias=alias):
                self.assertEqual(normalize_company_alias(alias), identity)

    def test_known_canonical_names_are_explicit_not_prefix_inferences(self):
        for name, key in [("Palantir Technologies", "palantirtechnologies"), ("Bosch Group", "boschgroup")]:
            with self.subTest(name=name):
                self.assertEqual(normalize_company_alias(name), COMPANY_ALIASES[key])

    def test_unrelated_prefix_never_inherits_domain_or_category(self):
        for name in ["Postman Pat Logistics", "Palantir Roofing Services", "Boschley Design", "Microsofton Bakery", "Stripefield Nursery"]:
            with self.subTest(name=name):
                normalized, category, domain = normalize_company_alias(name)
                self.assertEqual(normalized, name)
                self.assertIsNone(category)
                self.assertIsNone(domain)

    def test_unverified_product_or_regional_names_do_not_guess_parent_identity(self):
        # Probes, not observed employers. Add exact aliases only when independently evidenced.
        for name in ["Microsoft India", "Google Cloud", "Stripe Payments", "OpenAI OpCo", "Atlassian Pty", "Salesforce.com"]:
            with self.subTest(name=name):
                _, category, domain = normalize_company_alias(name)
                self.assertIsNone(category)
                self.assertIsNone(domain)

    def test_exact_alias_with_existing_legal_suffix_normalization(self):
        for name in ["Microsoft Inc.", "Microsoft Corporation", "Microsoft Ltd", "MICROSOFT", "  Microsoft  "]:
            with self.subTest(name=name):
                self.assertEqual(normalize_company_alias(name), COMPANY_ALIASES["microsoft"])

    def test_missing_and_unknown_names_remain_unmapped(self):
        for name in [None, "", "Unlisted Example Employer"]:
            with self.subTest(name=name):
                _, category, domain = normalize_company_alias(name)
                self.assertIsNone(category)
                self.assertIsNone(domain)


if __name__ == "__main__":
    unittest.main()
