-- ============================================================
-- Career Hound — Development Seed Data
-- Run AFTER schema.sql in: Supabase Dashboard → SQL Editor
-- 20 realistic jobs across roles, locations, and companies
-- Idempotent (Database row #62): safe to re-run - rows conflict on
-- apply_url (partial unique index jobs_apply_url_unique,
-- 20261001_ingestion_pipeline: UNIQUE (apply_url) WHERE apply_url IS NOT
-- NULL, so the ON CONFLICT arbiter repeats the same predicate) and are
-- skipped instead of duplicated.
-- ============================================================

insert into public.jobs
  (company, title, location, remote_scope, job_type, salary_text, description, skills, apply_url, source_url, status)
values

-- ── Backend / Engineering ─────────────────────────────────────────────────
(
  'Stripe',
  'Backend Engineer — Payments Infrastructure',
  'San Francisco, CA',
  'hybrid',
  'full-time',
  '$180k – $240k',
  'Join the Payments Infrastructure team to build the systems that process billions of dollars daily. You will design, implement, and scale distributed services using Go and Java, improve reliability across our global payments network, and collaborate with product and compliance teams to ship new payment methods.',
  array['Go', 'Java', 'Distributed Systems', 'PostgreSQL', 'Kafka'],
  'https://boards.greenhouse.io/stripe/jobs/4000001',
  'https://stripe.com/jobs',
  'active'
),
(
  'Razorpay',
  'Senior Software Engineer — Core Payments',
  'Bengaluru, India',
  'hybrid',
  'full-time',
  '₹40L – ₹60L',
  'Work on Razorpay''s core payments engine processing 5M+ transactions/day. Build high-availability microservices, optimize for sub-100ms latency, and lead technical design for new payment product lines.',
  array['Java', 'Spring Boot', 'MySQL', 'Redis', 'Kubernetes'],
  'https://boards.greenhouse.io/razorpay/jobs/4000002',
  'https://razorpay.com/jobs',
  'active'
),
(
  'Monzo',
  'Backend Engineer — Lending',
  'London, UK',
  'remote',
  'full-time',
  '£80k – £110k',
  'Build the next generation of credit products at Monzo. You''ll work in a small squad to design and ship the back-end services that power personal loans, overdrafts, and flexible payments. We use Go and are big on testing and observability.',
  array['Go', 'gRPC', 'PostgreSQL', 'Terraform', 'Datadog'],
  'https://boards.greenhouse.io/monzo/jobs/4000003',
  'https://monzo.com/careers',
  'active'
),
(
  'Groww',
  'Software Development Engineer II — Brokerage Platform',
  'Bengaluru, India',
  'onsite',
  'full-time',
  '₹30L – ₹45L',
  'Build and scale the brokerage platform serving 10M+ active investors. Responsibilities include designing low-latency order management services, ensuring SEBI compliance workflows, and improving real-time market data pipelines.',
  array['Java', 'Spring', 'Kafka', 'Elasticsearch', 'AWS'],
  'https://jobs.ashbyhq.com/groww/4000004',
  'https://groww.in/careers',
  'active'
),

-- ── Frontend / Full-Stack ─────────────────────────────────────────────────
(
  'Linear',
  'Software Engineer — Product (Frontend)',
  'Remote',
  'remote',
  'full-time',
  '$150k – $200k',
  'Linear builds software for teams who care about quality. You''ll work on our React application used by tens of thousands of engineering teams. Expect deep work on performance, animations, keyboard navigation, and real-time collaboration features.',
  array['TypeScript', 'React', 'GraphQL', 'CSS', 'Electron'],
  'https://jobs.ashbyhq.com/linear/4000005',
  'https://linear.app/careers',
  'active'
),
(
  'Loom',
  'Full-Stack Engineer — Core Product',
  'Remote',
  'remote',
  'full-time',
  '$140k – $180k',
  'Build the video communication product used by millions. You''ll work across our React frontend and Node.js/Python backend, improving the record-upload-share flow and building integrations with tools like Slack, Notion, and Jira.',
  array['React', 'TypeScript', 'Node.js', 'Python', 'WebRTC'],
  'https://boards.greenhouse.io/loom/jobs/4000006',
  'https://loom.com/careers',
  'active'
),
(
  'Zepto',
  'Senior Frontend Engineer — Consumer App',
  'Mumbai, India',
  'hybrid',
  'full-time',
  '₹28L – ₹42L',
  'Own the consumer-facing React Native and Next.js surfaces at Zepto. Drive performance improvements on our home feed, build A/B tested checkout flows, and work directly with design to ship pixel-perfect experiences at scale.',
  array['React Native', 'Next.js', 'TypeScript', 'Redux', 'GraphQL'],
  'https://jobs.ashbyhq.com/zepto/4000007',
  'https://zepto.team/careers',
  'active'
),

-- ── DevOps / Platform / SRE ───────────────────────────────────────────────
(
  'Cloudflare',
  'Site Reliability Engineer — Edge Network',
  'Austin, TX',
  'hybrid',
  'full-time',
  '$160k – $210k',
  'Keep Cloudflare''s global edge network running across 200+ cities. You will automate infrastructure provisioning with Terraform and Ansible, build runbooks, drive post-incident reviews, and improve observability across millions of requests per second.',
  array['Kubernetes', 'Terraform', 'Go', 'Prometheus', 'Linux'],
  'https://boards.greenhouse.io/cloudflare/jobs/4000008',
  'https://cloudflare.com/careers',
  'active'
),
(
  'CRED',
  'DevOps Engineer — Platform',
  'Bengaluru, India',
  'onsite',
  'full-time',
  '₹25L – ₹38L',
  'Own CI/CD pipelines, Kubernetes cluster operations, and cost optimisation for CRED''s AWS infrastructure. You''ll work closely with backend teams to reduce deployment times and build self-service developer tooling.',
  array['Kubernetes', 'AWS', 'Terraform', 'ArgoCD', 'Python'],
  'https://jobs.ashbyhq.com/cred/4000009',
  'https://cred.club/careers',
  'active'
),

-- ── Data / ML / AI ────────────────────────────────────────────────────────
(
  'Hugging Face',
  'ML Engineer — Open Source',
  'Remote',
  'remote',
  'full-time',
  '$130k – $170k',
  'Join the team that maintains the most-used open-source ML library in the world. You''ll work on Transformers, Diffusers, and PEFT — fixing bugs, reviewing community PRs, and shipping new model integrations.',
  array['Python', 'PyTorch', 'Transformers', 'CUDA', 'Git'],
  'https://boards.greenhouse.io/huggingface/jobs/4000010',
  'https://huggingface.co/jobs',
  'active'
),
(
  'Sarvam AI',
  'AI Engineer — Language Models',
  'Bengaluru, India',
  'onsite',
  'full-time',
  '₹35L – ₹55L',
  'Build and fine-tune large language models for Indian languages. You will work on pre-training runs, RLHF pipelines, and evaluation frameworks. Experience with distributed training on GPU clusters is a strong plus.',
  array['Python', 'PyTorch', 'RLHF', 'LLM', 'JAX'],
  'https://jobs.ashbyhq.com/sarvam/4000011',
  'https://sarvam.ai/careers',
  'active'
),
(
  'Weights & Biases',
  'Data Engineer — MLOps Platform',
  'Remote',
  'remote',
  'full-time',
  '$120k – $155k',
  'Build the data pipelines that power W&B''s model registry and artifact store. You''ll work with large-scale experiment metadata, design Clickhouse schemas, and improve query performance for millions of runs.',
  array['Python', 'dbt', 'Clickhouse', 'Airflow', 'Spark'],
  'https://boards.greenhouse.io/wandb/jobs/4000012',
  'https://wandb.ai/careers',
  'active'
),

-- ── Product / Design ──────────────────────────────────────────────────────
(
  'Notion',
  'Product Designer — Editor Experience',
  'Remote',
  'remote',
  'full-time',
  '$140k – $175k',
  'Own the design of Notion''s core editor — the block-based canvas used by millions daily. You''ll work on complex interaction design problems: inline AI, collaborative cursors, rich text editing, and mobile ergonomics.',
  array['Figma', 'Prototyping', 'User Research', 'Design Systems', 'Motion Design'],
  'https://boards.greenhouse.io/notion/jobs/4000013',
  'https://notion.so/careers',
  'active'
),
(
  'Meesho',
  'Senior Product Manager — Supplier Platform',
  'Bengaluru, India',
  'hybrid',
  'full-time',
  '₹35L – ₹50L',
  'Lead the Supplier Platform product area — the tools used by 1M+ sellers to list, price, and fulfill orders on Meesho. You will define the roadmap, work closely with engineering and data science, and measure success via GMV and supplier NPS.',
  array['Product Strategy', 'SQL', 'A/B Testing', 'Stakeholder Management', 'Agile'],
  'https://jobs.ashbyhq.com/meesho/4000014',
  'https://meesho.io/careers',
  'active'
),

-- ── Security ──────────────────────────────────────────────────────────────
(
  'Wiz',
  'Security Engineer — Cloud Infrastructure',
  'Remote',
  'remote',
  'full-time',
  '$160k – $220k',
  'Work on the security product that protects the cloud infrastructure of Fortune 500 companies. You''ll research new attack vectors, build detection logic, and help customers understand their risk exposure through our graph-based cloud security platform.',
  array['Cloud Security', 'AWS', 'Python', 'Graph Databases', 'CSPM'],
  'https://boards.greenhouse.io/wiz/jobs/4000015',
  'https://wiz.io/careers',
  'active'
),

-- ── Mobile ────────────────────────────────────────────────────────────────
(
  'PhonePe',
  'iOS Engineer — UPI Payments',
  'Bengaluru, India',
  'hybrid',
  'full-time',
  '₹30L – ₹50L',
  'Build the iOS client for India''s largest UPI payments app used by 500M+ users. Responsibilities include improving app startup time, building new payment flows, and maintaining our Swift/Obj-C codebase with a focus on reliability and security.',
  array['Swift', 'Objective-C', 'UIKit', 'CoreData', 'XCTest'],
  'https://jobs.ashbyhq.com/phonepe/jobs/4000016',
  'https://phonepe.com/careers',
  'active'
),
(
  'Duolingo',
  'Android Engineer — Learning Experience',
  'Pittsburgh, PA',
  'hybrid',
  'full-time',
  '$140k – $180k',
  'Build the Android learning experience for 60M daily active learners. You''ll ship lessons, streaks, and gamification features in Kotlin, working closely with pedagogy researchers and data scientists to maximize learner engagement.',
  array['Kotlin', 'Jetpack Compose', 'Coroutines', 'Room', 'MVVM'],
  'https://boards.greenhouse.io/duolingo/jobs/4000017',
  'https://duolingo.com/careers',
  'active'
),

-- ── Infra / Systems ───────────────────────────────────────────────────────
(
  'PlanetScale',
  'Database Engineer — Vitess Core',
  'Remote',
  'remote',
  'full-time',
  '$150k – $200k',
  'Contribute to Vitess — the open-source MySQL clustering system that powers YouTube and PlanetScale. You''ll work on query routing, schema change workflows, and the online DDL system. Deep knowledge of MySQL internals is required.',
  array['Go', 'MySQL', 'Vitess', 'Distributed Databases', 'gRPC'],
  'https://boards.greenhouse.io/planetscale/jobs/4000018',
  'https://planetscale.com/careers',
  'active'
),
(
  'HashedIn (Deloitte)',
  'Cloud Architect — GCP / AWS',
  'Bengaluru, India',
  'hybrid',
  'full-time',
  '₹28L – ₹45L',
  'Lead cloud architecture engagements for enterprise clients migrating to GCP and AWS. Responsibilities include infra design, cost optimisation, and helping client engineering teams adopt IaC with Terraform and Pulumi.',
  array['GCP', 'AWS', 'Terraform', 'Pulumi', 'Python'],
  'https://jobs.ashbyhq.com/hashedin/jobs/4000019',
  'https://hashedin.com/careers',
  'active'
),

-- ── QA / Testing ──────────────────────────────────────────────────────────
(
  'BrowserStack',
  'Software Engineer — Test Automation Platform',
  'Mumbai, India',
  'hybrid',
  'full-time',
  '₹22L – ₹35L',
  'Build the test automation infrastructure that runs millions of tests daily across real devices and browsers. You''ll work on our Selenium and Playwright grid, improve scheduling algorithms, and reduce flakiness rates.',
  array['Java', 'Selenium', 'Playwright', 'Kubernetes', 'Python'],
  'https://jobs.ashbyhq.com/browserstack/jobs/4000020',
  'https://browserstack.com/careers',
  'active'
)
on conflict (apply_url) where apply_url is not null do nothing;
