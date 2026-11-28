# Row34 exact employer alias repair

The normalizer now resolves explicit normalized aliases and its existing legal-suffix variants only. Arbitrary name prefixes no longer transfer a canonical employer name, category or domain.

Palantir Technologies and Bosch Group are explicit entries because those full names are already present in the recorded seed corpus and match the existing canonical alias values. Comparing old and new normalizers through the existing file-only audit loader found zero output changes over560distinct seed/candidate names, including seed slugs.

Unknown names preserve their source-provided name with no canonical category/domain mapping. Product, subsidiary, regional and legal-entity names are not assumed to identify a parent employer. Plausible examples such as Google Cloud or Salesforce.com were reviewer probes, not observed runtime inputs; this repair does not add them without evidence. Future exact aliases can be added with source evidence and tests.

This is a bounded identity-safety fix, not complete employer recognition, agency classification, production-data validation, backfill or a change to downstream coarse category heuristics. No database changes or ingestion runs are included. The historical prefix-audit results describe the old behavior, not a current nonzero prefix risk in the repaired normalizer.
