# Security Policy

## Reporting a Vulnerability

Please report security issues through the contact page at
https://careermonke.com/contact with the subject line "SECURITY".

- Do **not** open a public GitHub issue for a vulnerability.
- Include: affected URL or route, steps to reproduce, impact, and any
  proof-of-concept material.
- We aim to acknowledge reports within 72 hours and to share a remediation
  plan within 7 days.

## Scope

In scope: the CareerMonke web application (careermonke.com) and its API
routes, authentication and authorization logic, payment flow, and data
handling of user resumes and profile data.

Out of scope: third-party services (Supabase, Groq, Razorpay, Google),
denial-of-service testing, and issues requiring physical access.

## Notes

- There is no bug bounty program at this time.
- Automated scanner output without a demonstrated impact is treated as
  low priority.
- Dependencies are scanned continuously in CI (npm audit baseline,
  Gitleaks secret scanning, dependency review on pull requests).
