import pytest

from scripts.scraper.run_ingestion import _cohort_matches, _validated_source_filter


def test_cohorts_are_disjoint_and_cover_every_supported_source_type():
    source_types = (
        "greenhouse", "lever", "ashby", "smartrecruiters", "workday",
        "amazon", "microsoft", "jobspy", "arbeitnow", "adzuna",
    )
    for source_type in source_types:
        membership = sum(_cohort_matches(cohort, source_type) for cohort in ("workday", "non-workday"))
        assert membership == 1, source_type


def test_aliases_cannot_move_a_workday_board_between_cohorts():
    assert _cohort_matches("workday", "workday")
    assert not _cohort_matches("non-workday", "workday")
    assert _cohort_matches("non-workday", "greenhouse")


def test_source_selector_rejects_empty_unknown_and_all_combined_with_alias():
    config = {"layer1_public_ats": [{"ats": "greenhouse", "slug": "acme"}], "layer2_enterprise_json": {}}
    with pytest.raises(ValueError):
        _validated_source_filter([""], config)
    with pytest.raises(ValueError):
        _validated_source_filter(["not-a-source"], config)
    with pytest.raises(ValueError):
        _validated_source_filter(["all", "greenhouse"], config)
    assert _validated_source_filter(["greenhouse:acme"], config) == {"greenhouse:acme"}
