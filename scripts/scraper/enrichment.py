"""Deterministic identity building, length-framed UTF-8 similarity hashing (v2), and enrichment.

Contract:
- Authoritative write identity: stable board/account source_id + provider source_job_id.
- Similarity hashing (v2): Unicode-preserving, NFKC normalized (sharp s folded to ss), length-framed UTF-8 payload,
  and SHA-256 digest, strictly advisory (no unique constraint or auto-expiry).
- Tech skill keyword extraction via single-pass Aho-Corasick automaton.
- 4-category company taxonomy and 5-category role taxonomy classifiers.
"""

from __future__ import annotations

import hashlib
import html
import re
import unicodedata
from collections import deque

COMPANY_CATEGORIES = (
    "MNC_BIGTECH",
    "HIGH_PRODUCT_YC",
    "OTHER_STARTUPS",
    "INDIAN_IT_AND_OTHER",
)

ROLE_CATEGORIES = ("SDE", "AI_ML", "CLOUD", "DATA", "OTHER")

# ============================================================================
# 1. AUTHORITATIVE WRITE IDENTITY HELPERS
# ============================================================================


def build_source_id(vendor: str, board_token: str) -> str:
    """Builds canonical source_id '<vendor>:<board_token>'.

    Enforces that both vendor and board_token are non-empty strings.
    """
    if not vendor or not isinstance(vendor, str) or not vendor.strip():
        raise ValueError("vendor must be a non-empty string")
    if not board_token or not isinstance(board_token, str) or not board_token.strip():
        raise ValueError("board_token must be a non-empty string")
    return f"{vendor.strip().lower()}:{board_token.strip().lower()}"


_WHITESPACE_RE = re.compile(
    r"[ \t\n\r\f\v\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+"
)
_COMPANY_SUFFIX_RE = re.compile(
    r"(?<![^\W_])(inc|llc|ltd|corp|corporation|limited|pvt|private|gmbh|plc|co)\.?(?![^\W_])",
    re.IGNORECASE,
)


def clean_location_key(location_key: str | None) -> str:
    """Normalizes location key for scoped job identity framing: NFC, lowercased, edge chars mapped, whitespace collapsed."""
    if not location_key or not isinstance(location_key, str):
        return ""
    loc = unicodedata.normalize("NFC", location_key).lower()
    loc = loc.replace("İ", "i").replace("\u0130", "i").replace("i\u0307", "i")
    loc = loc.replace("ς", "σ").replace("\u03c2", "\u03c3")
    loc = loc.replace("\u0085", " ")
    loc = _WHITESPACE_RE.sub(" ", loc).strip()
    return loc


def build_scoped_job_identity(
    source_id: str,
    provider_job_id: str,
    location_key: str | None = None,
) -> tuple[str, str]:
    """Builds authoritative (source_id, source_job_id) tuple.

    Uses injective, Unicode-safe, length-framed location identity:
    f"{clean_pid}#{loc_len}:{clean_loc}". Escapes '#' and '%' inside provider_job_id.
    Rejects missing or empty source identity components.
    """
    if not source_id or not isinstance(source_id, str) or not source_id.strip():
        raise ValueError("source_id must be a non-empty string")
    if not provider_job_id or not isinstance(provider_job_id, str) or not str(provider_job_id).strip():
        raise ValueError("provider_job_id must be a non-empty string")

    clean_source_id = source_id.strip().lower()
    clean_pid = str(provider_job_id).strip().replace("%", "%25").replace("#", "%23")

    if location_key and isinstance(location_key, str) and location_key.strip():
        clean_loc = clean_location_key(location_key)
        if clean_loc:
            loc_len = len(clean_loc.encode("utf-8"))
            clean_job_id = f"{clean_pid}#{loc_len}:{clean_loc}"
        else:
            clean_job_id = clean_pid
    else:
        clean_job_id = clean_pid

    return clean_source_id, clean_job_id


# ============================================================================
# 2. VERSIONED SIMILARITY CONTRACT (v2 LENGTH-FRAMED UTF-8 SHA-256)
# ============================================================================



def clean_company(company: str | None) -> str:
    """Normalizes company name: NFKC, lowercased, edge chars mapped, legal suffixes stripped, whitespace collapsed."""
    if not company or not isinstance(company, str):
        return ""
    c = unicodedata.normalize("NFKC", company).lower()
    c = c.replace("İ", "i").replace("\u0130", "i").replace("i\u0307", "i")
    c = c.replace("ς", "σ").replace("\u03c2", "\u03c3").replace("ß", "ss")
    c = c.replace("\u0085", " ")
    c = _COMPANY_SUFFIX_RE.sub(" ", c)
    c = _WHITESPACE_RE.sub(" ", c).strip()
    return c


def clean_title(title: str | None) -> str:
    """Normalizes job title: NFKC, lowercased, edge chars mapped, whitespace collapsed."""
    if not title or not isinstance(title, str):
        return ""
    t = unicodedata.normalize("NFKC", title).lower()
    t = t.replace("İ", "i").replace("\u0130", "i").replace("i\u0307", "i")
    t = t.replace("ς", "σ").replace("\u03c2", "\u03c3").replace("ß", "ss")
    t = t.replace("\u0085", " ")
    t = _WHITESPACE_RE.sub(" ", t).strip()
    return t


def clean_country(country: str | None) -> str:
    """Normalizes country code: NFKC, lowercased, edge chars mapped, whitespace collapsed."""
    if not country or not isinstance(country, str):
        return ""
    co = unicodedata.normalize("NFKC", country).lower()
    co = co.replace("İ", "i").replace("\u0130", "i").replace("i\u0307", "i")
    co = co.replace("ς", "σ").replace("\u03c2", "\u03c3").replace("ß", "ss")
    co = co.replace("\u0085", " ")
    co = _WHITESPACE_RE.sub(" ", co).strip()
    return co


def clean_location(location: str | None) -> str:
    """Normalizes primary location/city segment before comma: NFKC, lowercased, edge chars mapped, whitespace collapsed."""
    if not location or not isinstance(location, str):
        return ""
    loc = unicodedata.normalize("NFKC", location).lower()
    loc = loc.replace("İ", "i").replace("\u0130", "i").replace("i\u0307", "i")
    loc = loc.replace("ς", "σ").replace("\u03c2", "\u03c3").replace("ß", "ss")
    loc = loc.replace("\u0085", " ")
    loc = loc.split(",")[0]
    loc = _WHITESPACE_RE.sub(" ", loc).strip()
    return loc


def build_similarity_payload_v2(
    company: str | None,
    title: str | None,
    country: str | None = None,
    location: str | None = None,
) -> str:
    """Builds length-framed UTF-8 serialization payload.

    Format: v2|c:{len}:{comp}|t:{len}:{title}|co:{len}:{co}|loc:{len}:{loc}
    Prevents delimiter collisions across all characters.
    """
    c = clean_company(company)
    t = clean_title(title)
    co = clean_country(country)
    loc = clean_location(location)

    c_len = len(c.encode("utf-8"))
    t_len = len(t.encode("utf-8"))
    co_len = len(co.encode("utf-8"))
    loc_len = len(loc.encode("utf-8"))

    return f"v2|c:{c_len}:{c}|t:{t_len}:{t}|co:{co_len}:{co}|loc:{loc_len}:{loc}"


def compute_similarity_hash_v2(
    company: str | None,
    title: str | None,
    country: str | None = None,
    location: str | None = None,
) -> str:
    """Computes deterministic SHA-256 hex digest using v2 length-framed UTF-8 payload.

    Matches PostgreSQL public.compute_job_similarity_hash_v2() and TypeScript byte-for-byte.
    """
    payload = build_similarity_payload_v2(company, title, country, location)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def compute_dedupe_hash(
    company: str | None,
    title: str | None,
    country: str | None = None,
    location: str | None = None,
) -> str:
    """Canonical Job Dedupe Hash Contract (v2).

    Produces byte-for-byte identical output across PostgreSQL, TypeScript, and Python:
    `v2|c:{len}:{comp}|t:{len}:{title}|co:{len}:{co}|loc:{len}:{loc}` hashed with SHA-256.
    """
    return compute_similarity_hash_v2(company, title, country, location)


def compute_legacy_dedupe_hash(
    company: str | None,
    title: str | None,
    country: str | None = None,
    location: str | None = None,
) -> str:
    """Legacy plain dedupe hash (pre-v2 plain format with [^a-z0-9]+ stripping).

    Retained for backward-compatibility audits and backfill verification only.
    """
    raw_comp = (company or "").lower().strip()
    norm_comp = _COMPANY_SUFFIX_RE.sub(" ", raw_comp)
    norm_comp = re.sub(r"[^a-z0-9]+", " ", norm_comp).strip()

    raw_title = (title or "").lower().strip()
    norm_title = re.sub(r"[^a-z0-9]+", " ", raw_title).strip()

    raw_co = (country or "").strip()
    norm_co = re.sub(r"[^a-z0-9]+", " ", (raw_co or "any").lower()).strip() or "any"

    first_city = (location or "").split(",")[0] if location else ""
    norm_city = re.sub(r"[^a-z0-9]+", " ", first_city.lower()).strip() or "any"

    payload = f"{norm_comp}|{norm_title}|{norm_co}|{norm_city}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ============================================================================
# 3. ENRICHMENT TAXONOMIES & EXTRACTORS
# ============================================================================

SKILL_SYNONYMS: list[tuple[str, str]] = [
    ("python", "Python"),
    ("typescript", "TypeScript"),
    ("javascript", "JavaScript"),
    ("ecmascript", "JavaScript"),
    ("java", "Java"),
    ("golang", "Go"),
    ("rust", "Rust"),
    ("c++", "C++"),
    ("c#", "C#"),
    (".net", "C#"),
    ("react", "React"),
    ("reactjs", "React"),
    ("react.js", "React"),
    ("next.js", "Next.js"),
    ("nextjs", "Next.js"),
    ("node.js", "Node.js"),
    ("nodejs", "Node.js"),
    ("vue.js", "Vue.js"),
    ("vuejs", "Vue.js"),
    ("angular", "Angular"),
    ("svelte", "Svelte"),
    ("graphql", "GraphQL"),
    ("rest api", "REST API"),
    ("restful", "REST API"),
    ("grpc", "gRPC"),
    ("sql", "SQL"),
    ("postgresql", "PostgreSQL"),
    ("postgres", "PostgreSQL"),
    ("mysql", "MySQL"),
    ("mongodb", "MongoDB"),
    ("redis", "Redis"),
    ("kafka", "Kafka"),
    ("rabbitmq", "RabbitMQ"),
    ("elasticsearch", "Elasticsearch"),
    ("opensearch", "Elasticsearch"),
    ("aws", "AWS"),
    ("amazon web services", "AWS"),
    ("gcp", "GCP"),
    ("google cloud", "GCP"),
    ("azure", "Azure"),
    ("docker", "Docker"),
    ("kubernetes", "Kubernetes"),
    ("k8s", "Kubernetes"),
    ("terraform", "Terraform"),
    ("ansible", "Ansible"),
    ("ci/cd", "CI/CD"),
    ("github actions", "CI/CD"),
    ("gitlab ci", "CI/CD"),
    ("jenkins", "CI/CD"),
    ("linux", "Linux"),
    ("pytorch", "PyTorch"),
    ("tensorflow", "TensorFlow"),
    ("llm", "LLM"),
    ("llms", "LLM"),
    ("large language model", "LLM"),
    ("large language models", "LLM"),
    ("genai", "GenAI"),
    ("generative ai", "GenAI"),
    ("rag", "RAG"),
    ("retrieval augmented", "RAG"),
    ("retrieval-augmented", "RAG"),
    ("langchain", "LangChain"),
    ("nlp", "NLP"),
    ("natural language processing", "NLP"),
    ("computer vision", "Computer Vision"),
    ("machine learning", "Machine Learning"),
    ("deep learning", "Deep Learning"),
    ("mlops", "MLOps"),
    ("spark", "Spark"),
    ("pyspark", "Spark"),
    ("apache spark", "Spark"),
    ("snowflake", "Snowflake"),
    ("databricks", "Databricks"),
    ("bigquery", "BigQuery"),
    ("airflow", "Airflow"),
    ("dbt", "dbt"),
    ("pandas", "Pandas"),
    ("scikit-learn", "Scikit-Learn"),
    ("sklearn", "Scikit-Learn"),
    ("spring boot", "Spring Boot"),
    ("django", "Django"),
    ("fastapi", "FastAPI"),
    ("flask", "Flask"),
    ("ruby on rails", "Ruby on Rails"),
    ("kotlin", "Kotlin"),
    ("swift", "Swift"),
    ("flutter", "Flutter"),
    ("react native", "React Native"),
    ("microservices", "Microservices"),
    ("distributed systems", "Distributed Systems"),
    ("system design", "System Design"),
    ("tailwind", "Tailwind CSS"),
    ("prisma", "Prisma"),
    ("supabase", "Supabase"),
    ("dynamodb", "DynamoDB"),
    ("cassandra", "Cassandra"),
    ("clickhouse", "ClickHouse"),
    ("prometheus", "Prometheus"),
    ("grafana", "Grafana"),
    ("datadog", "Datadog"),
    ("playwright", "Playwright"),
    ("cypress", "Cypress"),
]


class AhoCorasickExtractor:
    """Single-pass Aho-Corasick trie automaton with word-boundary verification."""

    def __init__(self, patterns: list[tuple[str, str]]) -> None:
        self.transitions: list[dict[str, int]] = [{}]
        self.fail: list[int] = [0]
        self.outputs: list[list[tuple[int, str]]] = [[]]

        for phrase, label in patterns:
            node = 0
            p_lower = phrase.lower()
            for ch in p_lower:
                if ch not in self.transitions[node]:
                    nxt = len(self.transitions)
                    self.transitions.append({})
                    self.fail.append(0)
                    self.outputs.append([])
                    self.transitions[node][ch] = nxt
                node = self.transitions[node][ch]
            self.outputs[node].append((len(p_lower), label))

        queue: deque[int] = deque()
        for ch, nxt in self.transitions[0].items():
            self.fail[nxt] = 0
            queue.append(nxt)

        while queue:
            cur = queue.popleft()
            for ch, nxt in self.transitions[cur].items():
                queue.append(nxt)
                f = self.fail[cur]
                while f > 0 and ch not in self.transitions[f]:
                    f = self.fail[f]
                self.fail[nxt] = self.transitions[f].get(ch, 0)
                if self.outputs[self.fail[nxt]]:
                    self.outputs[nxt].extend(self.outputs[self.fail[nxt]])

    def extract(self, text: str, max_results: int = 8) -> list[str]:
        if not text:
            return []
        t_lower = text.lower()
        t_len = len(t_lower)
        node = 0
        seen: set[str] = set()
        results: list[str] = []

        for idx, ch in enumerate(t_lower):
            while node > 0 and ch not in self.transitions[node]:
                node = self.fail[node]
            node = self.transitions[node].get(ch, 0)

            if self.outputs[node]:
                for match_len, label in self.outputs[node]:
                    start_idx = idx - match_len + 1
                    end_idx = idx + 1
                    if start_idx > 0:
                        prev_ch = t_lower[start_idx - 1]
                        if prev_ch.isalnum() or prev_ch in ("#", "+", "."):
                            continue
                    if end_idx < t_len:
                        next_ch = t_lower[end_idx]
                        if next_ch.isalnum() or next_ch in ("#", "+", "."):
                            continue
                    if label not in seen:
                        seen.add(label)
                        results.append(label)
                        if len(results) >= max_results:
                            return results
        return results


_GLOBAL_EXTRACTOR: AhoCorasickExtractor | None = None


def get_extractor() -> AhoCorasickExtractor:
    global _GLOBAL_EXTRACTOR
    if _GLOBAL_EXTRACTOR is None:
        _GLOBAL_EXTRACTOR = AhoCorasickExtractor(SKILL_SYNONYMS)
    return _GLOBAL_EXTRACTOR


_HTML_TAG_RE = re.compile(r"<[^>]+>")


def strip_html(text: str | None) -> str:
    if not text:
        return ""
    clean = _HTML_TAG_RE.sub(" ", text)
    clean = html.unescape(clean)
    return " ".join(clean.split())


def extract_top_keywords(
    title: str | None,
    description: str | None = None,
    max_keywords: int = 8,
) -> list[str]:
    """Extracts up to 8 technical skills prioritizing title matches."""
    extractor = get_extractor()
    seen: set[str] = set()
    result: list[str] = []

    if title:
        for k in extractor.extract(title, max_results=max_keywords):
            if k not in seen:
                seen.add(k)
                result.append(k)

    if len(result) < max_keywords and description:
        plain_desc = strip_html(description)
        for k in extractor.extract(plain_desc, max_results=max_keywords):
            if k not in seen:
                seen.add(k)
                result.append(k)
                if len(result) >= max_keywords:
                    break

    return result[:max_keywords]


_REMOTE_KEYWORDS_RE = re.compile(
    r"\b(remote|work from home|wfh|telecommute|distributed|anywhere|virtual)\b",
    re.IGNORECASE,
)
_ONSITE_KEYWORDS_RE = re.compile(
    r"\b(on-site|onsite|in-office|in office|hybrid)\b",
    re.IGNORECASE,
)


def detect_remote_status(
    location: str | None,
    title: str | None = None,
    description: str | None = None,
    raw_remote: bool | None = None,
) -> bool:
    """Determines is_remote status with location > title > raw_remote precedence."""
    loc = (location or "").lower()
    t = (title or "").lower()

    if _REMOTE_KEYWORDS_RE.search(loc) or loc.strip() in ("remote", "telecommute", "anywhere"):
        return True
    if _REMOTE_KEYWORDS_RE.search(t):
        return True
    if raw_remote is True:
        if _ONSITE_KEYWORDS_RE.search(loc) and not _REMOTE_KEYWORDS_RE.search(loc):
            return False
        return True
    return False


def classify_role_category(title: str | None, description: str | None = None) -> str:
    """Classifies job into: 'SDE', 'AI_ML', 'CLOUD', 'DATA', or 'OTHER'."""
    t = (title or "").lower()
    desc = (description or "")[:500].lower()
    combined = f"{t} {desc}"

    if re.search(
        r"\b(ai|ml|machine learning|deep learning|llm|genai|generative ai|computer vision|nlp|data scientist|research scientist|applied scientist|prompt engineer)\b",
        t,
    ):
        return "AI_ML"
    if re.search(
        r"\b(cloud|devops|site reliability|sre|platform engineer|infrastructure|systems engineer|k8s|kubernetes|terraform|sysadmin|devsecops|security engineer|network engineer)\b",
        t,
    ):
        return "CLOUD"
    if re.search(
        r"\b(data engineer|data analyst|analytics engineer|business intelligence|\bbi\b|etl|data warehouse|database administrator|\bdba\b|snowflake|databricks|spark)\b",
        t,
    ):
        return "DATA"
    if re.search(
        r"\b(software|sde|developer|engineer|backend|back-end|frontend|front-end|full stack|full-stack|fullstack|mobile|ios|android|web|firmware|embedded|qa|sdet|architect|programmer)\b",
        combined,
    ) and not re.search(
        r"\b(account executive|sales|recruiter|talent|marketing|finance|accountant|legal|counsel|human resources|customer success)\b",
        t,
    ):
        return "SDE"
    return "OTHER"


def assign_legacy_category(title: str | None, role_category: str) -> str:
    """Maps to legacy frontend category slug so existing filter pills work unchanged."""
    if role_category == "AI_ML":
        return "ai"
    if role_category == "CLOUD":
        return "devops"
    if role_category == "DATA":
        return "data"
    t = (title or "").lower()
    if re.search(r"\b(design|ui|ux)\b", t):
        return "design"
    if re.search(r"\b(product manager|program manager|project manager|\btpm\b)\b", t):
        return "product"
    if re.search(r"\b(marketing|growth|seo|brand)\b", t):
        return "marketing"
    if re.search(r"\b(sales|account executive|business development|\bbdr\b)\b", t):
        return "sales"
    if re.search(r"\b(qa|quality assurance|test engineer|sdet)\b", t):
        return "qa-testing"
    if re.search(r"\b(finance|accountant|payroll)\b", t):
        return "finance"
    if re.search(r"\b(recruiter|talent|human resources|\bhr\b)\b", t):
        return "hr"
    return "engineering"


def resolve_logo_url(ats_logo_url: str | None, canonical_domain: str | None) -> str | None:
    """Resolves logo from ATS metadata or domain icon, or None for frontend initial-avatar fallback."""
    if ats_logo_url and isinstance(ats_logo_url, str):
        trimmed = ats_logo_url.strip()
        if trimmed.startswith("https://") or trimmed.startswith("http://"):
            return trimmed
    if canonical_domain and isinstance(canonical_domain, str):
        dom = canonical_domain.strip().lower().removeprefix("https://").removeprefix("http://").removeprefix("www.").split("/")[0]
        if "." in dom:
            return f"https://www.google.com/s2/favicons?domain={dom}&sz=128"
    return None


def detect_country_code(location: str | None) -> str | None:
    """Lightweight country code detector for common locations."""
    if not location:
        return None
    loc = location.lower()
    mapping = [
        (r"\b(united states|usa|u\.s\.a\.|u\.s\.|san francisco|new york|seattle|austin|boston|chicago|los angeles|sunnyvale|santa clara|mountain view|menlo park|palo alto|redmond|bellevue|bentonville|atlanta|denver|dallas)\b", "US"),
        (r"\b(india|bengaluru|bangalore|hyderabad|pune|mumbai|gurgaon|gurugram|noida|chennai|delhi|new delhi|ncr|bhubaneswar|kolkata|ahmedabad|kochi)\b", "IN"),
        (r"\b(united kingdom|\buk\b|london|manchester|edinburgh|cambridge)\b", "GB"),
        (r"\b(canada|toronto|vancouver|montreal|waterloo|ottawa)\b", "CA"),
        (r"\b(germany|berlin|munich|frankfurt|hamburg)\b", "DE"),
        (r"\b(singapore)\b", "SG"),
        (r"\b(ireland|dublin)\b", "IE"),
        (r"\b(france|paris)\b", "FR"),
        (r"\b(netherlands|amsterdam)\b", "NL"),
        (r"\b(australia|sydney|melbourne)\b", "AU"),
        (r"\b(japan|tokyo)\b", "JP"),
        (r"\b(brazil|sao paulo|são paulo)\b", "BR"),
        (r"\b(poland|warsaw|krakow)\b", "PL"),
        (r"\b(spain|madrid|barcelona)\b", "ES"),
        (r"\b(israel|tel aviv)\b", "IL"),
    ]
    for pattern, code in mapping:
        if re.search(pattern, loc):
            return code
    return None


def classify_company_category(
    company_name: str | None,
    canonical_domain: str | None = None,
    seed_category: str | None = None,
) -> str:
    """Classifies company into 4-category taxonomy."""
    if seed_category and seed_category in COMPANY_CATEGORIES:
        return seed_category

    c_name = (company_name or "").lower().strip()
    dom = (canonical_domain or "").lower().strip()

    bigtech_names = {
        "google", "alphabet", "microsoft", "amazon", "apple", "meta", "facebook",
        "netflix", "nvidia", "uber", "airbnb", "stripe", "salesforce", "adobe",
        "oracle", "cisco", "intel", "amd", "qualcomm", "ibm", "snowflake",
        "databricks", "palantir", "linkedin", "atlassian", "spotify", "shopify",
    }
    if c_name in bigtech_names or any(b in dom for b in ("google.com", "microsoft.com", "amazon.com", "apple.com", "meta.com", "netflix.com", "nvidia.com", "stripe.com")):
        return "MNC_BIGTECH"

    indian_it_names = {
        "tcs", "tata consultancy services", "infosys", "wipro", "hcl tech", "hcl technologies",
        "tech mahindra", "cognizant", "l&t infotech", "lti", "ltimindtree", "mindtree",
        "mphasis", "hexaware", "persistent systems", "cyient", "birlasoft", "coforge",
    }
    if c_name in indian_it_names:
        return "INDIAN_IT_AND_OTHER"

    return "OTHER_STARTUPS"


COMPANY_ALIASES: dict[str, tuple[str, str, str | None]] = {
    # token -> (canonical_name, category, canonical_domain)
    "tcs": ("Tata Consultancy Services", "INDIAN_IT_AND_OTHER", "tcs.com"),
    "tataconsultancyservices": ("Tata Consultancy Services", "INDIAN_IT_AND_OTHER", "tcs.com"),
    "infosys": ("Infosys", "INDIAN_IT_AND_OTHER", "infosys.com"),
    "infosyslimited": ("Infosys", "INDIAN_IT_AND_OTHER", "infosys.com"),
    "wipro": ("Wipro", "INDIAN_IT_AND_OTHER", "wipro.com"),
    "wiprolimited": ("Wipro", "INDIAN_IT_AND_OTHER", "wipro.com"),
    "hcl": ("HCLTech", "INDIAN_IT_AND_OTHER", "hcltech.com"),
    "hcltech": ("HCLTech", "INDIAN_IT_AND_OTHER", "hcltech.com"),
    "hcltechnologies": ("HCLTech", "INDIAN_IT_AND_OTHER", "hcltech.com"),
    "cognizant": ("Cognizant", "INDIAN_IT_AND_OTHER", "cognizant.com"),
    "cognizanttechnologysolutions": ("Cognizant", "INDIAN_IT_AND_OTHER", "cognizant.com"),
    "techmahindra": ("Tech Mahindra", "INDIAN_IT_AND_OTHER", "techmahindra.com"),
    "ltimindtree": ("LTIMindtree", "INDIAN_IT_AND_OTHER", "ltimindtree.com"),
    "mindtree": ("LTIMindtree", "INDIAN_IT_AND_OTHER", "ltimindtree.com"),
    "larsentoubroinfotech": ("LTIMindtree", "INDIAN_IT_AND_OTHER", "ltimindtree.com"),
    "ltts": ("L&T Technology Services", "INDIAN_IT_AND_OTHER", "ltts.com"),
    "capgemini": ("Capgemini", "INDIAN_IT_AND_OTHER", "capgemini.com"),
    "accenture": ("Accenture", "INDIAN_IT_AND_OTHER", "accenture.com"),
    "deloitte": ("Deloitte", "INDIAN_IT_AND_OTHER", "deloitte.com"),
    "mphasis": ("Mphasis", "INDIAN_IT_AND_OTHER", "mphasis.com"),
    "persistent": ("Persistent Systems", "INDIAN_IT_AND_OTHER", "persistent.com"),
    "persistentsystems": ("Persistent Systems", "INDIAN_IT_AND_OTHER", "persistent.com"),
    "coforge": ("Coforge", "INDIAN_IT_AND_OTHER", "coforge.com"),
    "hexaware": ("Hexaware Technologies", "INDIAN_IT_AND_OTHER", "hexaware.com"),
    "zensar": ("Zensar Technologies", "INDIAN_IT_AND_OTHER", "zensar.com"),
    "birlasoft": ("Birlasoft", "INDIAN_IT_AND_OTHER", "birlasoft.com"),
    "kpit": ("KPIT Technologies", "INDIAN_IT_AND_OTHER", "kpit.com"),
    "tataelxsi": ("Tata Elxsi", "INDIAN_IT_AND_OTHER", "tataelxsi.com"),
    "genpact": ("Genpact", "INDIAN_IT_AND_OTHER", "genpact.com"),
    "wns": ("WNS", "INDIAN_IT_AND_OTHER", "wns.com"),
    "exl": ("EXL Service", "INDIAN_IT_AND_OTHER", "exlservice.com"),
    "musigma": ("Mu Sigma", "INDIAN_IT_AND_OTHER", "mu-sigma.com"),
    "fractal": ("Fractal Analytics", "INDIAN_IT_AND_OTHER", "fractal.ai"),
    "tigeranalytics": ("Tiger Analytics", "INDIAN_IT_AND_OTHER", "tigeranalytics.com"),
    "nagarro": ("Nagarro", "INDIAN_IT_AND_OTHER", "nagarro.com"),
    "zoho": ("Zoho", "MNC_BIGTECH", "zoho.com"),
    "freshworks": ("Freshworks", "MNC_BIGTECH", "freshworks.com"),
    "google": ("Google", "MNC_BIGTECH", "google.com"),
    "alphabet": ("Google", "MNC_BIGTECH", "google.com"),
    "microsoft": ("Microsoft", "MNC_BIGTECH", "microsoft.com"),
    "amazon": ("Amazon", "MNC_BIGTECH", "amazon.com"),
    "aws": ("Amazon", "MNC_BIGTECH", "amazon.com"),
    "amazonwebservices": ("Amazon", "MNC_BIGTECH", "amazon.com"),
    "meta": ("Meta", "MNC_BIGTECH", "meta.com"),
    "facebook": ("Meta", "MNC_BIGTECH", "meta.com"),
    "apple": ("Apple", "MNC_BIGTECH", "apple.com"),
    "netflix": ("Netflix", "MNC_BIGTECH", "netflix.com"),
    "nvidia": ("NVIDIA", "MNC_BIGTECH", "nvidia.com"),
    "walmart": ("Walmart", "MNC_BIGTECH", "walmart.com"),
    "walmartglobaltech": ("Walmart", "MNC_BIGTECH", "walmart.com"),
    "salesforce": ("Salesforce", "MNC_BIGTECH", "salesforce.com"),
    "mastercard": ("Mastercard", "MNC_BIGTECH", "mastercard.com"),
    "visa": ("Visa", "MNC_BIGTECH", "visa.com"),
    "adobe": ("Adobe", "MNC_BIGTECH", "adobe.com"),
    "cisco": ("Cisco", "MNC_BIGTECH", "cisco.com"),
    "oracle": ("Oracle", "MNC_BIGTECH", "oracle.com"),
    "ibm": ("IBM", "MNC_BIGTECH", "ibm.com"),
    "sap": ("SAP", "MNC_BIGTECH", "sap.com"),
    "uber": ("Uber", "MNC_BIGTECH", "uber.com"),
    "atlassian": ("Atlassian", "MNC_BIGTECH", "atlassian.com"),
    "datadog": ("Datadog", "MNC_BIGTECH", "datadoghq.com"),
    "cloudflare": ("Cloudflare", "MNC_BIGTECH", "cloudflare.com"),
    "palantir": ("Palantir Technologies", "MNC_BIGTECH", "palantir.com"),
    "bosch": ("Bosch Group", "MNC_BIGTECH", "bosch.com"),
    "stripe": ("Stripe", "HIGH_PRODUCT_YC", "stripe.com"),
    "openai": ("OpenAI", "HIGH_PRODUCT_YC", "openai.com"),
    "anthropic": ("Anthropic", "HIGH_PRODUCT_YC", "anthropic.com"),
    "linear": ("Linear", "HIGH_PRODUCT_YC", "linear.app"),
    "ramp": ("Ramp", "HIGH_PRODUCT_YC", "ramp.com"),
    "notion": ("Notion", "HIGH_PRODUCT_YC", "notion.so"),
    "supabase": ("Supabase", "HIGH_PRODUCT_YC", "supabase.com"),
    "figma": ("Figma", "HIGH_PRODUCT_YC", "figma.com"),
    "vercel": ("Vercel", "HIGH_PRODUCT_YC", "vercel.com"),
    "airbnb": ("Airbnb", "HIGH_PRODUCT_YC", "airbnb.com"),
    "brex": ("Brex", "HIGH_PRODUCT_YC", "brex.com"),
    "gitlab": ("GitLab", "HIGH_PRODUCT_YC", "gitlab.com"),
    "scaleai": ("Scale AI", "HIGH_PRODUCT_YC", "scale.com"),
    "perplexity": ("Perplexity AI", "HIGH_PRODUCT_YC", "perplexity.ai"),
    "perplexityai": ("Perplexity AI", "HIGH_PRODUCT_YC", "perplexity.ai"),
    "elevenlabs": ("ElevenLabs", "HIGH_PRODUCT_YC", "elevenlabs.io"),
    "posthog": ("PostHog", "HIGH_PRODUCT_YC", "posthog.com"),
    "retool": ("Retool", "HIGH_PRODUCT_YC", "retool.com"),
    "gusto": ("Gusto", "HIGH_PRODUCT_YC", "gusto.com"),
    "mistral": ("Mistral AI", "HIGH_PRODUCT_YC", "mistral.ai"),
    "mistralai": ("Mistral AI", "HIGH_PRODUCT_YC", "mistral.ai"),
    "plaid": ("Plaid", "HIGH_PRODUCT_YC", "plaid.com"),
    "wise": ("Wise", "HIGH_PRODUCT_YC", "wise.com"),
    "razorpay": ("Razorpay", "HIGH_PRODUCT_YC", "razorpay.com"),
    "zerodha": ("Zerodha", "HIGH_PRODUCT_YC", "zerodha.com"),
    "cred": ("CRED", "HIGH_PRODUCT_YC", "cred.club"),
    "swiggy": ("Swiggy", "HIGH_PRODUCT_YC", "swiggy.com"),
    "zomato": ("Zomato", "HIGH_PRODUCT_YC", "zomato.com"),
    "phonepe": ("PhonePe", "HIGH_PRODUCT_YC", "phonepe.com"),
    "zepto": ("Zepto", "HIGH_PRODUCT_YC", "zeptonow.com"),
    "postman": ("Postman", "HIGH_PRODUCT_YC", "postman.com"),
    "browserstack": ("BrowserStack", "HIGH_PRODUCT_YC", "browserstack.com"),
}

_IT_SERVICE_PATTERN_RE = re.compile(
    r"\b(consultancy|consulting|infotech|services|outsourcing|staffing|bpo|solutions\s+pvt|technologies\s+pvt|systems\s+pvt|global\s+services|it\s+services)\b",
    re.IGNORECASE,
)


def normalize_company_alias(company_name: str | None) -> tuple[str, str | None, str | None]:
    """
    Normalizes company name aliases.
    Returns (canonical_company_name, matched_category_or_None, canonical_domain_or_None).
    """
    raw = (company_name or "Unknown").strip()
    stripped = _COMPANY_SUFFIX_RE.sub("", raw).strip()
    token = re.sub(r"[^a-z0-9]", "", stripped.lower())
    if token in COMPANY_ALIASES:
        return COMPANY_ALIASES[token]

    raw_token = re.sub(r"[^a-z0-9]", "", raw.lower())
    if raw_token in COMPANY_ALIASES:
        return COMPANY_ALIASES[raw_token]

    for alias_key, (canon_name, cat, dom) in COMPANY_ALIASES.items():
        if len(alias_key) >= 5 and token.startswith(alias_key):
            return canon_name, cat, dom

    return (stripped or raw), None, None


def assign_company_category(
    seed_category: str | None,
    company_name: str,
    slug: str = "",
    source_layer: str = "layer1",
    country_code: str | None = None,
) -> str:
    """Deterministically assigns one of the 4 company categories."""
    if seed_category in COMPANY_CATEGORIES:
        return seed_category

    _, alias_cat, _ = normalize_company_alias(company_name)
    if alias_cat in COMPANY_CATEGORIES:
        return alias_cat

    if slug:
        _, slug_cat, _ = normalize_company_alias(slug)
        if slug_cat in COMPANY_CATEGORIES:
            return slug_cat

    if source_layer == "layer2":
        return "MNC_BIGTECH"

    combined = f"{company_name} {slug}".strip()
    if _IT_SERVICE_PATTERN_RE.search(combined):
        return "INDIAN_IT_AND_OTHER"
    if (country_code or "").upper() == "IN" and re.search(r"\b(pvt|private|limited|ltd|tech|technologies|solutions)\b", combined, re.IGNORECASE):
        return "INDIAN_IT_AND_OTHER"

    return "OTHER_STARTUPS"


def assign_role_category(
    title: str | None,
    department: str | None = None,
    top_keywords: list[str] | None = None,
) -> str:
    """Deterministically assigns one of ('SDE', 'AI_ML', 'CLOUD', 'DATA', 'OTHER')."""
    t = (title or "").lower()
    d = (department or "").lower()
    kws = " ".join(top_keywords or []).lower()
    combined = f"{t} {d} {kws}"

    if re.search(
        r"\b(ai|ml|machine learning|deep learning|llm|genai|generative ai|nlp|computer vision|data scientist|research scientist|applied scientist|mlops)\b",
        t,
    ):
        return "AI_ML"
    if re.search(
        r"\b(cloud|devops|sre|site reliability|infrastructure|platform engineer|kubernetes|aws|gcp|azure|terraform|devsecops|security engineer|network engineer)\b",
        t,
    ):
        return "CLOUD"
    if re.search(
        r"\b(data engineer|data analyst|analytics engineer|business intelligence|\bbi\b|etl|data warehouse|database administrator|\bdba\b|snowflake|databricks|spark)\b",
        t,
    ):
        return "DATA"
    if re.search(
        r"\b(software|sde|developer|engineer|backend|back-end|frontend|front-end|full stack|full-stack|fullstack|mobile|ios|android|web|firmware|embedded|qa|sdet|architect|programmer)\b",
        combined,
    ) and not re.search(
        r"\b(account executive|sales|recruiter|talent|marketing|finance|accountant|legal|counsel|human resources|customer success)\b",
        t,
    ):
        return "SDE"
    return "OTHER"


def assign_legacy_category(title: str | None, role_category: str) -> str:
    """Maps to legacy frontend category slug so existing filter pills work unchanged."""
    if role_category == "AI_ML":
        return "ai"
    if role_category == "CLOUD":
        return "devops"
    if role_category == "DATA":
        return "data"
    t = (title or "").lower()
    if re.search(r"\b(design|ui|ux)\b", t):
        return "design"
    if re.search(r"\b(product manager|program manager|project manager|\btpm\b)\b", t):
        return "product"
    if re.search(r"\b(marketing|growth|seo|brand)\b", t):
        return "marketing"
    if re.search(r"\b(sales|account executive|business development|\bbdr\b)\b", t):
        return "sales"
    if re.search(r"\b(qa|quality assurance|test engineer|sdet)\b", t):
        return "qa-testing"
    if re.search(r"\b(finance|accountant|payroll)\b", t):
        return "finance"
    if re.search(r"\b(recruiter|talent|human resources|\bhr\b)\b", t):
        return "hr"
    return "engineering"
