"""Aho-Corasick + Regex keyword extractor, category rules, logo resolver, and SHA-256 dedupe."""

from __future__ import annotations

import hashlib
import html
import re
from collections import deque

COMPANY_CATEGORIES = (
    "MNC_BIGTECH",
    "HIGH_PRODUCT_YC",
    "OTHER_STARTUPS",
    "INDIAN_IT_AND_OTHER",
)

ROLE_CATEGORIES = ("SDE", "AI_ML", "CLOUD", "DATA", "OTHER")

# Static tech skill taxonomy: (alias_phrase_lowercase, canonical_label)
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

    @staticmethod
    def _is_word_char(ch: str) -> bool:
        return ch.isalnum() or ch == "_"

    def extract(self, text: str, max_keywords: int = 8) -> list[str]:
        if not text:
            return []
        lower = text.lower()
        n = len(lower)
        node = 0
        found: list[str] = []
        seen: set[str] = set()

        for idx, ch in enumerate(lower):
            while node > 0 and ch not in self.transitions[node]:
                node = self.fail[node]
            node = self.transitions[node].get(ch, 0)
            if not self.outputs[node]:
                continue
            for pat_len, label in self.outputs[node]:
                start = idx - pat_len + 1
                end = idx + 1
                if start > 0 and self._is_word_char(lower[start - 1]):
                    continue
                if end < n and self._is_word_char(lower[end]):
                    continue
                key = label.lower()
                if key not in seen:
                    seen.add(key)
                    found.append(label)
                    if len(found) >= max_keywords:
                        return found
        return found


_EXTRACTOR = AhoCorasickExtractor(SKILL_SYNONYMS)
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def strip_html(raw: str | None) -> str:
    if not raw:
        return ""
    unescaped = html.unescape(raw)
    cleaned = _HTML_TAG_RE.sub(" ", unescaped)
    return _WS_RE.sub(" ", cleaned).strip()


def extract_top_keywords(
    title: str | None = None,
    description: str | None = None,
    existing_skills: list[str] | None = None,
    max_keywords: int = 8,
) -> list[str]:
    """Extracts up to 8 deduplicated technical skills from existing tags, title, and JD."""
    results: list[str] = []
    seen: set[str] = set()

    def _add(item: str) -> None:
        cleaned = item.strip()
        if not cleaned or len(cleaned) > 35:
            return
        k = cleaned.lower()
        if k not in seen:
            seen.add(k)
            results.append(cleaned)

    if existing_skills:
        for sk in existing_skills:
            if isinstance(sk, str):
                _add(sk)
                if len(results) >= max_keywords:
                    return results[:max_keywords]

    for kw in _EXTRACTOR.extract(title or "", max_keywords=max_keywords):
        _add(kw)
        if len(results) >= max_keywords:
            return results[:max_keywords]

    clean_desc = strip_html(description)
    for kw in _EXTRACTOR.extract(clean_desc, max_keywords=max_keywords * 2):
        _add(kw)
        if len(results) >= max_keywords:
            return results[:max_keywords]

    return results[:max_keywords]


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


_COMPANY_SUFFIX_RE = re.compile(
    r"\b(inc|llc|ltd|corp|corporation|limited|pvt|private|gmbh|plc|co)\b\.?",
    re.IGNORECASE,
)
_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")


def compute_dedupe_hash(
    company: str | None,
    title: str | None,
    country: str | None = None,
    location: str | None = None,
) -> str:
    """SHA-256 hex of normalized company + normalized title + country + city (matches SQL & TS)."""
    norm_company = _COMPANY_SUFFIX_RE.sub("", (company or "").lower().strip())
    norm_company = _NON_ALNUM_RE.sub(" ", norm_company).strip()

    norm_title = _NON_ALNUM_RE.sub(" ", (title or "").lower().strip()).strip()

    raw_country = (country or "").strip() or "any"
    norm_country = _NON_ALNUM_RE.sub(" ", raw_country.lower()).strip() or "any"

    first_city = ((location or "").split(",")[0] or "").lower().strip()
    norm_city = _NON_ALNUM_RE.sub(" ", first_city).strip() or "any"

    payload = f"{norm_company}|{norm_title}|{norm_country}|{norm_city}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


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
