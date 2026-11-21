"""Tests for versioned identity contract (v2) and language-neutral golden cases.

Verifies:
1. Exact byte-for-byte match with scripts/fixtures/identity_golden_cases.json.
2. All 11 golden cases:
   - Case 1: PayPay Japanese roles (Product Manager vs Backend Engineer) distinct.
   - Case 2: New Relic Japanese sales territories (Tokyo vs Osaka) distinct.
   - Case 3: ClickHouse support vs consulting vs TAM distinct.
   - Case 4: Wolt Óbuda vs Buda distinct (accented Ó preserved).
   - Case 5: Alan territory flags ([FR] vs [ES]) distinct.
   - Case 6: Bilingual / ASCII punctuation variants (- vs / vs :) distinct.
   - Case 7: Composed vs decomposed accented text (NFC vs NFD equivalence).
   - Case 8: Null and empty values handled gracefully without exception.
   - Case 9: Delimiter characters (| and :) injection safety.
   - Case 10: Same title & location with distinct requisition IDs.
   - Case 11: Provider job IDs duplicated across different boards.
3. build_source_id and build_scoped_job_identity contract invariants and validations.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.scraper.enrichment import (
    build_scoped_job_identity,
    build_similarity_payload_v2,
    build_source_id,
    compute_dedupe_hash,
    compute_similarity_hash_v2,
)

FIXTURES_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "identity_golden_cases.json"


def load_golden_cases() -> dict:
    with open(FIXTURES_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def test_golden_cases_all_pass():
    golden_data = load_golden_cases()
    assert golden_data["version"] == "v2"
    assert golden_data["contract"] == "length_framed_utf8_sha256"

    cases = golden_data["cases"]
    assert len(cases) == 24, f"Expected 24 golden cases, found {len(cases)}"

    for c in cases:
        case_id = c["id"]
        outcome = c["expected_outcome"]
        items = c["items"]

        hashes: list[str] = []
        for item in items:
            inp = item["input"]
            computed_payload = build_similarity_payload_v2(
                inp["company"], inp["title"], inp["country"], inp["location"]
            )
            computed_hash = compute_similarity_hash_v2(
                inp["company"], inp["title"], inp["country"], inp["location"]
            )

            # Assert exact byte-for-byte parity with golden JSON vectors
            assert computed_payload == item["expected_payload"], (
                f"[{case_id} - {item['label']}] Payload mismatch!\n"
                f"Computed: {computed_payload}\nExpected: {item['expected_payload']}"
            )
            assert computed_hash == item["expected_hash"], (
                f"[{case_id} - {item['label']}] Hash mismatch!\n"
                f"Computed: {computed_hash}\nExpected: {item['expected_hash']}"
            )

            # Verify backward-compatibility alias behaves identically
            assert compute_dedupe_hash(
                inp["company"], inp["title"], inp["country"], inp["location"]
            ) == computed_hash

            # If authoritative keys are specified, assert their construction
            if "authoritative" in item:
                auth = item["authoritative"]
                if "providerJobId" in auth and "expectedSourceJobId" in auth:
                    src_id, scoped_job_id = build_scoped_job_identity(
                        auth["sourceId"], auth["providerJobId"], auth.get("locationKey")
                    )
                    assert scoped_job_id == auth["expectedSourceJobId"], (
                        f"[{case_id} - {item['label']}] Authoritative source_job_id mismatch!\n"
                        f"Computed: {scoped_job_id}\nExpected: {auth['expectedSourceJobId']}"
                    )

            hashes.append(computed_hash)

        # Assert case-level invariants
        if outcome == "distinct_hashes":
            assert len(hashes) == 2
            assert hashes[0] != hashes[1], f"[{case_id}] Expected distinct hashes, got collision!"
        elif outcome == "all_distinct_hashes":
            assert len(set(hashes)) == len(hashes), f"[{case_id}] Expected all distinct hashes, found collision!"
        elif outcome == "identical_hashes":
            assert len(set(hashes)) == 1, f"[{case_id}] Expected identical hashes, found difference!"
        elif outcome == "identical_similarity_hash_but_distinct_authoritative_keys":
            assert hashes[0] == hashes[1], f"[{case_id}] Similarity hashes should match!"
            auth_0 = items[0]["authoritative"]
            auth_1 = items[1]["authoritative"]
            assert (auth_0["sourceId"], auth_0["sourceJobId"]) != (auth_1["sourceId"], auth_1["sourceJobId"])
        elif outcome == "distinct_authoritative_keys":
            if "sourceJobId" in items[0]["authoritative"]:
                auth_0 = items[0]["authoritative"]
                auth_1 = items[1]["authoritative"]
                assert (auth_0["sourceId"], auth_0["sourceJobId"]) != (auth_1["sourceId"], auth_1["sourceJobId"])


def test_build_source_id_validations():
    assert build_source_id("Greenhouse", "Stripe") == "greenhouse:stripe"
    assert build_source_id(" lever ", " Figma ") == "lever:figma"
    assert build_source_id("Ashby", "Airtable") == "ashby:airtable"

    with pytest.raises(ValueError, match="vendor must be a non-empty string"):
        build_source_id("", "stripe")

    with pytest.raises(ValueError, match="board_token must be a non-empty string"):
        build_source_id("greenhouse", "   ")


def test_build_scoped_job_identity_validations():
    # Single location or non-scoped
    src_id, job_id = build_scoped_job_identity("greenhouse:stripe", "REQ-1001")
    assert src_id == "greenhouse:stripe"
    assert job_id == "REQ-1001"

    # Multi-location with location key (length-framed, Unicode safe)
    src_id, job_id = build_scoped_job_identity("greenhouse:stripe", "REQ-1001", "Tokyo, Japan")
    assert src_id == "greenhouse:stripe"
    assert job_id == "REQ-1001#12:tokyo, japan"

    # Japanese non-ASCII location keys: Tokyo vs Osaka must NOT collide
    tokyo_src, tokyo_job = build_scoped_job_identity("greenhouse:paypay", "REQ", "東京")
    osaka_src, osaka_job = build_scoped_job_identity("greenhouse:paypay", "REQ", "大阪")
    assert tokyo_src == "greenhouse:paypay"
    assert osaka_src == "greenhouse:paypay"
    assert tokyo_job == "REQ#6:東京"
    assert osaka_job == "REQ#6:大阪"
    assert tokyo_job != osaka_job

    # Provider ID with '#' delimiter character does not alias
    hash_src, hash_job = build_scoped_job_identity("greenhouse:stripe", "REQ#6")
    assert hash_job == "REQ%236"
    assert hash_job != tokyo_job

    # Scoped provider ID with '#' and location key
    scoped_src, scoped_job = build_scoped_job_identity("greenhouse:stripe", "REQ#42", "Berlin")
    assert scoped_job == "REQ%2342#6:berlin"

    # Validation errors on empty inputs
    with pytest.raises(ValueError, match="source_id must be a non-empty string"):
        build_scoped_job_identity("", "REQ-1001")

    with pytest.raises(ValueError, match="provider_job_id must be a non-empty string"):
        build_scoped_job_identity("greenhouse:stripe", "")


DEDUPE_VECTORS_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "job_dedupe_test_vectors.json"


def test_canonical_dedupe_hash_test_vectors():
    """Requirement 4: Verify shared canonical job dedupe test vectors in Python scraper."""
    with open(DEDUPE_VECTORS_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    assert data["version"] == "v2"
    assert data["algorithm"] == "sha256"
    assert data["contract"] == "length_framed_utf8_sha256"

    vectors = data["vectors"]
    assert len(vectors) >= 20, f"Expected at least 20 test vectors, found {len(vectors)}"

    for v in vectors:
        vec_id = v["id"]
        inp = v["input"]
        payload = build_similarity_payload_v2(
            inp["company"], inp["title"], inp["country"], inp["location"]
        )
        dedupe_hash = compute_dedupe_hash(
            inp["company"], inp["title"], inp["country"], inp["location"]
        )

        assert payload == v["expected_payload"], (
            f"[{vec_id}] Payload mismatch!\n"
            f"Computed: {payload}\nExpected: {v['expected_payload']}"
        )
        assert dedupe_hash == v["expected_hash"], (
            f"[{vec_id}] Hash mismatch!\n"
            f"Computed: {dedupe_hash}\nExpected: {v['expected_hash']}"
        )


if __name__ == "__main__":
    test_golden_cases_all_pass()
    test_canonical_dedupe_hash_test_vectors()
    test_build_source_id_validations()
    test_build_scoped_job_identity_validations()
    print("ALL PYTHON IDENTITY CONTRACT TESTS PASSED!")
