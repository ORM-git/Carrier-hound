# Key management and vendor terms (Backend sheet rows: Key Management Service, Vendor DPAs on File)

Status: inventory and tracking template. It changes no code or setting, and it records no vendor term, key or
agreement. Nothing here was checked against a vendor dashboard or contract. Both rows stay PARTIAL.

## Key management (no dedicated KMS)

Evidence in the repo: `docs/security/secrets-rotation-runbook.md` lists each secret and where it is stored.
In summary, secrets live in GitHub Actions secrets and the Cloudflare Pages and Netlify environment stores, and the
Supabase JWT signing secret and database password live in the Supabase dashboard. `.env.example` holds names only.
The Gitleaks job in `.github/workflows/security-scan.yml` scans for committed keys.

What this means:

- There is no separate key service. Each host's environment store is the key store, and the provider holds the
  encryption at rest (provider-side, owner to confirm in each vendor's documentation).
- Access to those stores is controlled by dashboard accounts, not by this repo. Who holds access is not visible here.
- Two items are marked PENDING in the runbook (JWT signing secret rotation and the unsubscribe secret setup). They
  are owner steps and are not closed by this doc.

Owner decisions (for the keeper's Doc):

1. Confirm who has access to each store and that each has MFA on.
2. Decide whether a dedicated key service is wanted at the current stage, or whether the host stores are enough.
3. Do the two PENDING items in the runbook when ready.

## Vendor DPAs and terms (tracking template)

The sheet says terms were accepted online and no DPA records are tracked. The vendor list is `docs/subprocessors.md`
and the risk notes are `docs/vendor-risk-review.md`. Keep the actual documents in the owner's private store, not in
this repo. This table only tracks status. Every cell below is unverified until the owner fills it in.

| Vendor | Terms accepted online (date) | DPA signed or incorporated (date, link in private store) | Data region | Retention setting | Owner who checked | Next review |
| --- | --- | --- | --- | --- | --- | --- |
| Supabase | unverified | unverified | unverified | unverified | | |
| Cloudflare | unverified | unverified | unverified | unverified | | |
| Netlify | unverified | unverified | unverified | unverified | | |
| Groq | unverified | unverified | unverified | unverified | | |
| Sentry | unverified | unverified | unverified | unverified | | |
| Google (mail) | unverified | unverified | unverified | unverified | | |
| Razorpay (payments off) | unverified | unverified | unverified | unverified | | |

Rules for filling it in:

- Write "unverified" until a document has been read. Never write "compliant" from memory.
- Record the date and where the document is kept. Do not paste contract text or account exports into the repo.
- Re-review when a vendor is added (see the change gate in `docs/vendor-risk-review.md`) and before payments are on.

## What stays unproven

- Any vendor term, DPA status, region or retention value.
- Who can read each secret store.
- Whether stored secrets are encrypted at rest beyond what each provider states.
