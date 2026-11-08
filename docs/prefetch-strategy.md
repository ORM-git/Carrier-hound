# Route prefetch & preload strategy (row 26)

Deliberate strategy (engineering decision, open to owner review):

- **Default Next `<Link>` viewport prefetch stays ON** for in-app navigation.
  This is the framework default and requires no code.
- **Curated opt-outs (`prefetch={false}`)** guard against prefetch storms on
  expensive routes — a dashboard listing dozens of job cards would otherwise
  fire one route/data prefetch per visible card link into the jobs API:
  - `src/app/dashboard/page.tsx` (job list links)
  - `src/components/GuideHeader.tsx` (primary nav: /jobs, /resume,
    /applications, /remote, /pricing)
  - `src/components/UserMenu.tsx`
  - `src/components/Footer.tsx` (landing-owned; many low-value public links)
- **Font preloading**: via `next/font` in the root layout (automatic).
- **Preconnect**: browser-fetch third-party origins are preconnected in the
  root layout head. The current list is exactly one origin — unavatar.io
  (company-logo avatars on public pages). Every other third-party origin in
  the codebase is either server-to-server (Supabase, Razorpay, Google APIs)
  or an outbound `<a href>` (social, job boards), where preconnect does
  nothing.

`scripts/test-prefetch-strategy.ts` (CI) pins this strategy: no new
`prefetch={false}` outside the curated allowlist, every curated client-fetch
origin preconnected, `next/font` in use.
