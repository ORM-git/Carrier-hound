"""Unit tests for conditional_state (pure file/dict logic; stub-level: temp dirs and dicts, no network, no DB)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.scraper import conditional_state as cs

NOW = datetime(2026, 11, 28, 12, 0, tzinfo=timezone.utc)
SID = "greenhouse:acme"
URL = "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true&pay_transparency=true"
HDRS = {"ETag": '"v1"', "Last-Modified": "Sat, 28 Nov 2026 00:00:00 GMT"}
KEY = cs.board_key(SID, URL)


def _boards(**over):
    b: dict = {}
    assert cs.record_full_fetch(b, SID, URL, HDRS, NOW)
    b[KEY].update(over)
    return b


class ConditionalStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = str(Path(self.dir.name) / "s" / "state.json")

    def tearDown(self) -> None:
        self.dir.cleanup()

    def _write(self, obj) -> None:
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        Path(self.path).write_text(obj if isinstance(obj, str) else json.dumps(obj), encoding="utf-8")

    def test_missing_state(self) -> None:
        self.assertEqual(cs.load_state(self.path), ({}, "missing"))
        self.assertEqual(cs.load_state(None), ({}, "missing"))

    def test_round_trip_and_no_tmp_left(self) -> None:
        cs.save_state(self.path, _boards(), NOW)
        boards, status = cs.load_state(self.path, NOW)
        self.assertEqual(status, "ok")
        self.assertEqual(boards[KEY]["etag"], '"v1"')
        self.assertFalse(Path(self.path + ".tmp").exists())

    def test_corrupt_variants_fall_back_to_empty(self) -> None:
        good = _boards()[KEY]
        bad_entries = [
            {"etag": '"x"'},
            {**good, "url": "ftp://x/y"},
            {**good, "etag": "a\r\nX: y"},
            {**good, "etag": "z" * 600, "last_modified": None},
            {**good, "etag": ""},  # empty is never a validator
            {**good, "auth_scope": "weird"},
            {**good, "auth_scope": "auth"},
            {**good, "source_id": 5},
            {**good, "last_full_fetch_at": "not a time"},
        ]
        cases: list = ["not json", [1, 2], {"version": 2, "sources": {}}, {"version": 1, "sources": []}]
        cases += [{"version": 1, "sources": {KEY: e}} for e in bad_entries]
        cases.append({"version": 1, "sources": {"wrong-key": good}})  # key does not match its own fields
        for c in cases:
            self._write(c)
            self.assertEqual(cs.load_state(self.path, NOW), ({}, "corrupt"), str(c)[:60])

    def test_future_dated_entry_on_load_is_corrupt(self) -> None:
        cs.save_state(self.path, _boards(last_full_fetch_at=(NOW + timedelta(days=1)).isoformat()), NOW + timedelta(days=1))
        self.assertEqual(cs.load_state(self.path, NOW)[1], "corrupt")
        self.assertEqual(cs.load_state(self.path, NOW + timedelta(days=1))[1], "ok")

    # --- v5: control characters, URL and source_id hardening ----------------------------

    CONTROL = ("\r", "\n", "\t", "\x00", "\x0b", "\x0c", "\x7f", "\x85", "\x9f", "\u2028")

    def _variants(self, base: str):
        for c in self.CONTROL:
            yield c + base  # leading
            yield base + c  # trailing
            yield base[:3] + c + base[3:]  # embedded

    def test_validators_with_control_chars_anywhere_are_rejected_not_repaired(self) -> None:
        for field in ("etag", "last-modified"):
            for v in self._variants('"abc123"'):
                b: dict = {}
                self.assertFalse(cs.record_full_fetch(b, SID, URL, {field: v}, NOW), repr(v))
                self.assertEqual(b, {})
                self.assertIsNone(cs._clean(v), repr(v))

    def test_one_clean_validator_does_not_launder_a_dirty_one(self) -> None:
        b: dict = {}
        self.assertTrue(cs.record_full_fetch(b, SID, URL, {"etag": '"ok"', "last-modified": "Sat\r\n"}, NOW))
        self.assertNotIn("last_modified", b[KEY])  # dirty one dropped, clean one kept
        self.assertEqual(b[KEY]["etag"], '"ok"')

    def test_edge_spaces_trimmed_but_edge_newline_rejected(self) -> None:
        self.assertEqual(cs._clean('  "a"  '), '"a"')
        for v in ('"a"\n', '\n"a"', '"a"\r\n', '\t"a"'):
            self.assertIsNone(cs._clean(v), repr(v))

    def test_non_ascii_validator_rejected(self) -> None:
        self.assertIsNone(cs._clean('"caf\u00e9"'))

    def test_url_and_source_id_with_control_chars_are_rejected(self) -> None:
        for u in self._variants(URL):
            b: dict = {}
            self.assertFalse(cs._safe_url(u), repr(u))
            self.assertFalse(cs.record_full_fetch(b, SID, u, HDRS, NOW), repr(u))
            self.assertEqual(cs.validators_for(_boards(), SID, u, NOW, 20), {})
            with self.assertRaises(ValueError):
                cs.board_key(SID, u)
        for sid in self._variants(SID):
            b = {}
            self.assertFalse(cs._safe_source_id(sid), repr(sid))
            self.assertFalse(cs.record_full_fetch(b, sid, URL, HDRS, NOW), repr(sid))
            with self.assertRaises(ValueError):
                cs.board_key(sid, URL)

    def test_source_id_charset_and_length(self) -> None:
        for bad in ("", "a b", "a/b", "a?x=1", "a" * (cs.MAX_SOURCE_ID_LEN + 1), "id\u00e9"):
            self.assertFalse(cs._safe_source_id(bad), repr(bad))
        for ok in ("greenhouse:acme", "lever:foo-bar_1.2"):
            self.assertTrue(cs._safe_source_id(ok), ok)

    def test_credentials_in_url_rejected(self) -> None:
        for u in ("https://user:pw@boards-api.greenhouse.io/v1/boards/a/jobs",
                  "https://user@boards-api.greenhouse.io/v1/boards/a/jobs",
                  "https://boards-api.greenhouse.io@evil.example.net/x"):
            b: dict = {}
            self.assertFalse(cs._safe_url(u), u)
            self.assertFalse(cs.record_full_fetch(b, SID, u, HDRS, NOW), u)
            with self.assertRaises(ValueError):
                cs.board_key(SID, u)

    def test_sensitive_query_params_rejected_case_insensitive(self) -> None:
        for name in ("token", "TOKEN", "Api_Key", "apikey", "secret", "Auth", "access_token", "password", "passwd",
                     "pwd", "Signature", "sig", "credential", "session_id", "bearer", "jwt", "key", "app_key"):
            u = f"https://api.lever.co/v0/postings/acme?mode=json&{name}=abc"
            b: dict = {}
            self.assertFalse(cs._safe_url(u), name)
            self.assertFalse(cs.record_full_fetch(b, "lever:acme", u, HDRS, NOW), name)
            self.assertEqual(cs.validators_for(_boards(), "lever:acme", u, NOW, 20), {}, name)
        self.assertTrue(cs._safe_url("https://api.lever.co/v0/postings/acme?mode=json"))
        self.assertTrue(cs._safe_url(URL))

    def test_url_shape_rules(self) -> None:
        bad = ("http://boards-api.greenhouse.io/x", "ftp://x/y", "https:///x", "https://h/x#frag", "https://h:99999/x",
               "//h/x", "", "https://h/ x", "https://h/x" + "p" * cs.MAX_URL_LEN)
        for u in bad:
            self.assertFalse(cs._safe_url(u), u)
        self.assertFalse(cs._safe_url(None))

    def test_load_rejects_unsafe_stored_fields(self) -> None:
        good = _boards()[KEY]
        unsafe = [
            {**good, "url": "https://user:pw@boards-api.greenhouse.io/v1/boards/acme/jobs"},
            {**good, "url": URL + "&token=abc"},
            {**good, "url": "http://boards-api.greenhouse.io/v1/boards/acme/jobs"},
            {**good, "url": URL + "\n"},
            {**good, "source_id": "greenhouse:acme\n"},
            {**good, "source_id": "a b"},
            {**good, "etag": '"a"\r\n'},
            {**good, "etag": "\n" + '"a"'},
            {**good, "last_modified": "Sat\x00"},
        ]
        for e in unsafe:
            self._write({"version": 1, "sources": {KEY: e}})
            self.assertEqual(cs.load_state(self.path, NOW), ({}, "corrupt"), str(e)[:80])

    def test_save_skips_unsafe_entries_and_keeps_good_ones(self) -> None:
        b = _boards()
        for i, patch_ in enumerate((
            {"etag": '"a"\r\n'}, {"last_modified": "x\n"}, {"url": URL + "&token=1"}, {"source_id": "a b"},
            {"url": "https://u:p@boards-api.greenhouse.io/x"}, {"auth_scope": "auth"},
        )):
            e = dict(b[KEY]); e.update(patch_); b[f"forged{i}"] = e
        cs.save_state(self.path, b, NOW)
        boards, status = cs.load_state(self.path, NOW)
        self.assertEqual((status, list(boards)), ("ok", [KEY]))

    def test_oversized_file_is_corrupt(self) -> None:
        self._write(" " * (cs.MAX_FILE_BYTES + 1))
        self.assertEqual(cs.load_state(self.path, NOW), ({}, "corrupt"))

    def test_validators_sent_when_fresh(self) -> None:
        h = cs.validators_for(_boards(), SID, URL, NOW + timedelta(hours=4), 20)
        self.assertEqual(h, {"If-None-Match": '"v1"', "If-Modified-Since": HDRS["Last-Modified"]})

    def test_max_age_forces_full_fetch(self) -> None:
        self.assertEqual(cs.validators_for(_boards(), SID, URL, NOW + timedelta(hours=21), 20), {})

    def test_future_timestamp_not_trusted(self) -> None:
        self.assertEqual(cs.validators_for(_boards(), SID, URL, NOW - timedelta(hours=2), 20), {})

    def test_key_binds_exact_url_including_query(self) -> None:
        b = _boards()
        self.assertEqual(cs.validators_for(b, SID, URL.replace("&pay_transparency=true", ""), NOW, 20), {})
        self.assertEqual(cs.validators_for(b, SID, URL.replace("content=true", "content=false"), NOW, 20), {})
        self.assertEqual(cs.validators_for(b, SID, URL.replace("boards/acme", "boards/other"), NOW, 20), {})
        self.assertNotEqual(cs.validators_for(b, SID, URL, NOW, 20), {})

    def test_key_binds_origin(self) -> None:
        b = _boards()
        for other in ("https://evil.example.net/v1/boards/acme/jobs", "http://boards-api.greenhouse.io/v1/boards/acme/jobs",
                      "https://boards-api.greenhouse.io:8443/v1/boards/acme/jobs"):
            self.assertEqual(cs.validators_for(b, SID, other, NOW, 20), {}, other)

    def test_auth_scope_is_anonymous_only(self) -> None:
        b = _boards()
        self.assertEqual(cs.validators_for(b, SID, URL, NOW, 20, auth_scope="auth"), {})
        self.assertFalse(cs.record_full_fetch(b, SID, URL, {"etag": '"auth-v"'}, NOW, auth_scope="auth"))
        self.assertEqual(list(b), [KEY])  # anon entry untouched, nothing stored for auth
        for scope in ("auth", "other", ""):
            with self.assertRaises(ValueError):
                cs.board_key(SID, URL, scope)
        cs.drop(b, SID, URL, auth_scope="auth")  # no-op, no raise
        self.assertEqual(list(b), [KEY])

    def test_key_binds_schema_version(self) -> None:
        self.assertTrue(KEY.startswith(cs.KEY_SCHEMA + "|"))
        b = _boards()
        with patch.object(cs, "KEY_SCHEMA", "k9"):
            self.assertEqual(cs.validators_for(b, SID, URL, NOW, 20), {})

    def test_unknown_or_malformed_entry(self) -> None:
        self.assertEqual(cs.validators_for({}, SID, URL, NOW), {})
        self.assertEqual(cs.validators_for({KEY: {"etag": '"a"'}}, SID, URL, NOW), {})
        self.assertEqual(cs.validators_for(_boards(), SID, "not a url", NOW), {})

    def test_record_requires_a_real_validator(self) -> None:
        for hdrs in ({"Content-Type": "x"}, {"etag": ""}, {"etag": "   ", "last-modified": ""}):
            b = _boards()
            self.assertFalse(cs.record_full_fetch(b, SID, URL, hdrs, NOW), hdrs)
            self.assertNotIn(KEY, b)  # stale entry dropped

    def test_record_cross_origin_final_url_drops(self) -> None:
        b = _boards()
        self.assertFalse(cs.record_full_fetch(b, SID, URL, {"ETag": '"n"'}, NOW, final_url="https://cdn.other.net/jobs"))
        self.assertNotIn(KEY, b)

    def test_record_rejects_header_injection_and_long_values(self) -> None:
        b: dict = {}
        self.assertFalse(cs.record_full_fetch(b, SID, URL, {"etag": '"a"\r\nX-Evil: 1'}, NOW))
        self.assertFalse(cs.record_full_fetch(b, SID, URL, {"etag": "q" * 600}, NOW))
        self.assertEqual(b, {})

    def test_record_case_insensitive_headers_and_partial(self) -> None:
        b: dict = {}
        self.assertTrue(cs.record_full_fetch(b, SID, URL, {"etag": 'W/"w"'}, NOW))
        e = b[KEY]
        self.assertEqual((e["etag"], "last_modified" in e, e["auth_scope"], e["source_id"]), ('W/"w"', False, "anon", SID))

    def test_drop(self) -> None:
        b = _boards()
        cs.drop(b, SID, URL)
        cs.drop(b, "missing", URL)
        self.assertEqual(b, {})

    def test_prune_old_entries_on_load_and_save(self) -> None:
        cs.save_state(self.path, _boards(last_full_fetch_at=(NOW - timedelta(days=15)).isoformat()), NOW)
        self.assertEqual(cs.load_state(self.path, NOW), ({}, "ok"))

    def test_entry_cap_keeps_newest(self) -> None:
        b: dict = {}
        with patch.object(cs, "MAX_ENTRIES", 3):
            for i in range(6):
                cs.record_full_fetch(b, f"s{i}", URL, {"etag": f'"{i}"'}, NOW + timedelta(minutes=i))
            cs.save_state(self.path, b, NOW + timedelta(minutes=10))
            boards, status = cs.load_state(self.path, NOW + timedelta(minutes=10))
        self.assertEqual((status, sorted(e["source_id"] for e in boards.values())), ("ok", ["s3", "s4", "s5"]))

    def test_save_skips_entries_whose_key_does_not_match(self) -> None:
        b = _boards()
        b["forged"] = dict(b[KEY])
        cs.save_state(self.path, b, NOW)
        boards, status = cs.load_state(self.path, NOW)
        self.assertEqual((status, list(boards)), ("ok", [KEY]))

    def _fill(self, n: int, etag_len: int = 512, url_pad: int = 0, step=timedelta(seconds=1)) -> dict:
        b: dict = {}
        for i in range(n):
            url = f"https://boards-api.greenhouse.io/v1/boards/b{i:05d}/jobs?content=true" + ("&x=" + "u" * url_pad if url_pad else "")
            hdrs = {"etag": '"' + "e" * (etag_len - 2) + '"', "last-modified": "L" * 100}
            self.assertTrue(cs.record_full_fetch(b, f"greenhouse:b{i:05d}", url, hdrs, NOW - timedelta(hours=1) + i * step))
        return b

    def test_writer_never_exceeds_loader_limit_with_max_entries_and_max_validators(self) -> None:
        b = self._fill(cs.MAX_ENTRIES, etag_len=512)
        cs.save_state(self.path, b, NOW)
        size = Path(self.path).stat().st_size
        self.assertLessEqual(size, cs.MAX_FILE_BYTES)
        boards, status = cs.load_state(self.path, NOW)
        self.assertEqual(status, "ok")
        self.assertLess(len(boards), cs.MAX_ENTRIES)  # something had to be evicted at 512-char validators
        self.assertGreater(len(boards), 0)

    def test_eviction_is_newest_first_and_deterministic(self) -> None:
        b = self._fill(cs.MAX_ENTRIES, etag_len=512)
        cs.save_state(self.path, b, NOW)
        first = Path(self.path).read_bytes()
        kept, _ = cs.load_state(self.path, NOW)
        newest = sorted(b, key=lambda k: (-cs._parse(b[k]["last_full_fetch_at"]).timestamp(), k))[: len(kept)]
        self.assertEqual(sorted(kept), sorted(newest))
        cs.save_state(self.path, dict(reversed(list(b.items()))), NOW)  # insertion order must not matter
        self.assertEqual(Path(self.path).read_bytes(), first)

    def test_eviction_tiebreak_is_key_ascending(self) -> None:
        b = self._fill(cs.MAX_ENTRIES, etag_len=512, step=timedelta(0))  # identical timestamps
        cs.save_state(self.path, b, NOW)
        kept, _ = cs.load_state(self.path, NOW)
        expect = sorted(b)[: len(kept)]
        self.assertEqual(sorted(kept), expect)

    def test_exactly_at_limit_boundary_fits_and_one_more_is_evicted(self) -> None:
        b = self._fill(60, etag_len=64)
        order = cs._eviction_order(b)
        size_all = len(cs._serialize({k: b[k] for k in order}))
        for limit, want in ((size_all, 60), (size_all - 1, 59)):
            with patch.object(cs, "MAX_FILE_BYTES", limit):
                cs.save_state(self.path, b, NOW)
                self.assertLessEqual(Path(self.path).stat().st_size, limit)
                boards, status = cs.load_state(self.path, NOW)
            self.assertEqual((status, len(boards)), ("ok", want))

    def test_small_state_untouched_by_size_logic(self) -> None:
        b = self._fill(5, etag_len=20)
        cs.save_state(self.path, b, NOW)
        boards, status = cs.load_state(self.path, NOW)
        self.assertEqual((status, boards), ("ok", b))

    def test_long_url_is_bounded(self) -> None:
        b: dict = {}
        long_url = "https://boards-api.greenhouse.io/x?" + "q" * cs.MAX_URL_LEN
        self.assertFalse(cs._valid_entry({"source_id": "s", "auth_scope": "anon", "url": long_url, "etag": '"a"',
                                          "last_full_fetch_at": NOW.isoformat()}))
        self.assertEqual(cs.validators_for(b, "s", long_url, NOW), {})

    def test_writer_output_is_always_loadable_over_many_shapes(self) -> None:
        for n, etag_len, pad in ((2000, 512, 0), (2000, 512, 1900), (1500, 300, 600), (300, 512, 1900)):
            b = self._fill(n, etag_len=etag_len, url_pad=pad)
            cs.save_state(self.path, b, NOW)
            self.assertLessEqual(Path(self.path).stat().st_size, cs.MAX_FILE_BYTES, (n, etag_len, pad))
            self.assertEqual(cs.load_state(self.path, NOW)[1], "ok", (n, etag_len, pad))

    def test_max_age_env_clamped(self) -> None:
        for raw, want in (("5", 5), ("0", 1), ("500", 48), ("bad", 20)):
            with patch.dict(os.environ, {"CONDITIONAL_MAX_AGE_HOURS": raw}):
                self.assertEqual(cs.max_age_hours(), want)
        os.environ.pop("CONDITIONAL_MAX_AGE_HOURS", None)
        self.assertEqual(cs.max_age_hours(), 20)

    def test_board_unchanged_is_not_a_list(self) -> None:
        u = cs.BoardUnchanged(SID, URL)
        self.assertNotIsInstance(u, list)
        self.assertTrue(u)  # truthy, unlike []


if __name__ == "__main__":
    unittest.main()
