import pytest

from scripts.scraper import ats_detect as ad


@pytest.mark.parametrize("url,ats,ids", [
    ("https://boards.greenhouse.io/stripe", "greenhouse", {"token": "stripe"}),
    ("https://job-boards.greenhouse.io/stripe/jobs/123?gh_src=abc", "greenhouse", {"token": "stripe"}),
    ("boards.greenhouse.io/embed/job_board?for=figma&utm_source=x", "greenhouse", {"token": "figma"}),
    ("https://boards-api.greenhouse.io/v1/boards/brex/jobs", "greenhouse", {"token": "brex"}),
    ("https://jobs.lever.co/palantir/", "lever", {"token": "palantir"}),
    ("HTTPS://JOBS.LEVER.CO/palantir/abc-123/apply?lever-source=li", "lever", {"token": "palantir"}),
    ("https://api.lever.co/v0/postings/palantir?mode=json", "lever", {"token": "palantir"}),
    ("https://jobs.ashbyhq.com/openai?utm_medium=x#top", "ashby", {"token": "openai"}),
    ("https://api.ashbyhq.com/posting-api/job-board/openai", "ashby", {"token": "openai"}),
    ("https://jobs.smartrecruiters.com/Visa/7438-engineer", "smartrecruiters", {"token": "Visa"}),
    ("https://careers.smartrecruiters.com/Visa", "smartrecruiters", {"token": "Visa"}),
    ("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite", "workday",
     {"tenant": "nvidia", "wd_cluster": "wd5", "site": "NVIDIAExternalCareerSite"}),
    ("https://walmart.wd504.myworkdayjobs.com/en-US/WalmartExternal/job/x/y_R1", "workday",
     {"tenant": "walmart", "wd_cluster": "wd504", "site": "WalmartExternal"}),
    ("https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs", "workday",
     {"tenant": "nvidia", "wd_cluster": "wd5", "site": "NVIDIAExternalCareerSite"}),
    ("https://wd3.myworkdaysite.com/en-US/recruiting/Acme/External", "workday",
     {"tenant": "acme", "wd_cluster": "wd3", "site": "External"}),
])
def test_supported_variants(url, ats, ids):
    d = ad.detect_ats(url)
    assert (d["status"], d["ats"], d["identifiers"]) == (ad.CANDIDATE, ats, ids)
    assert "not verified" in d["reason"]


def test_normalization_strips_tracking_fragment_www_and_trailing_slash():
    url, host, err = ad.normalize_url("  HTTP://WWW.Example.com:443/careers/?utm_source=a&team=eng&fbclid=z#x ")
    assert (url, host, err) == ("https://example.com/careers?team=eng", "example.com", None)
    assert ad.normalize_url("example.com/")[0] == "https://example.com"


@pytest.mark.parametrize("url", [
    "https://boards.greenhouse.io.evil.com/stripe",
    "https://jobs-lever.co/palantir",
    "https://jobs.ashbyhq.net/openai",
    "https://nvidia.wd5.myworkdayjobs.com.phish.io/Site",
    "https://evil-smartrecruiters.com/Visa",
])
def test_lookalikes_rejected(url):
    d = ad.detect_ats(url)
    assert d["status"] == ad.LOOKALIKE and d["ats"] is None and d["identifiers"] == {}


@pytest.mark.parametrize("url", ["https://clever.com/careers", "https://unilever.com", "https://www.workday.com/careers",
                                 "https://lever.co", "https://www.ashbyhq.com/careers"])
def test_plain_and_vendor_sites_are_website_only(url):
    assert ad.detect_ats(url)["status"] == ad.WEBSITE


@pytest.mark.parametrize("url", ["https://boards.greenhouse.io", "https://boards.greenhouse.io/embed/job_board",
                                 "https://jobs.lever.co/", "https://nvidia.wd5.myworkdayjobs.com/",
                                 "https://nvidia.myworkdayjobs.com/Site", "https://api.ashbyhq.com/other/openai"])
def test_ats_host_without_identifier_is_incomplete(url):
    assert ad.detect_ats(url)["status"] == ad.INCOMPLETE


@pytest.mark.parametrize("url,ats", [("https://job-boards.eu.greenhouse.io/roboyo", "greenhouse"),
                                     ("https://jobs.eu.lever.co/x", "lever"),
                                     ("https://apply.workable.com/acme/", "workable")])
def test_unsupported(url, ats):
    d = ad.detect_ats(url)
    assert (d["status"], d["ats"]) == (ad.UNSUPPORTED, ats)


@pytest.mark.parametrize("raw,status", [
    ("", ad.BLANK), ("   ", ad.BLANK), (None, ad.BLANK),
    ("not a url", ad.AMBIGUOUS), ("https://a.com, https://b.com", ad.AMBIGUOUS),
    ("ftp://example.com", ad.INVALID), ("mailto:jobs@example.com", ad.INVALID), ("https://localhost", ad.INVALID),
    ("https://exa_mple.com", ad.INVALID), ("https://example.com:99999", ad.INVALID), ("https://1.2.3.4", ad.INVALID),
    ("https://user:pw@example.com", ad.INVALID), ("http://[::1", ad.INVALID),
])
def test_blank_and_malformed(raw, status):
    assert ad.detect_ats(raw)["status"] == status
