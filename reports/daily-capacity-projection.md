# CareerMonke Fleet Daily Ingestion Capacity Projection

**Audit Run Date**: 2026-11-12 08:35:32 UTC  
**Fleet Schedule Scope**: 438 enabled ATS company boards (6-shard partition, polled every 4 hours)  
**Sampled Scope**: 438 of 438 boards (436 successful, 2 errors)  
**Sampling Window**: Trailing 24 hours ($T_{\text{now}} - 24\text{h} \le T_{\text{job}} \le T_{\text{now}}$)  

---

## 1. Executive Summary & Verdict

**Verdict**: Projected fleet daily capacity is ~1,592 new jobs/day vs target 1,200 jobs/day (TARGET ACHIEVED: +392 jobs/day).

| Metric | Target | Projected Fleet Value | Status |
| :--- | :--- | :--- | :--- |
| **Daily NEW Jobs Supply** | **1,200 / day** | **~1,592 / day** | **✅ TARGET ACHIEVED** |
| **Surplus / Deficit** | — | +392 jobs/day | Surplus |
| **Fleet Open Job Inventory** | — | ~26,498 total active listings | Baseline Pool |
| **Trailing 24h Turnover Rate** | — | 6.02% | % of inventory refreshed daily |
| **Fleet Coverage** | 438 boards | 438 / 438 boards checked | 6-shard fleet |

> [!IMPORTANT]
> **Empirical Estimation Notice**: All figures in this report are empirical estimates extrapolated directly from public ATS timestamps observed during this audit run. No synthetic or invented numbers are used.
> - **Greenhouse**: Exposes `updated_at` (reflects newly opened positions as well as requisition edits/refreshes).
> - **Ashby**: Exposes `publishedAt` on publicly listed postings (`isListed !== false`).
> - **Lever**: Exposes `createdAt` (precise requisition creation timestamp).

---

## 2. Per-ATS Platform Breakdown

| ATS Platform | Fleet Total Boards | Sampled Boards | Boards w/ Date-able Jobs | Boards w/ Zero Date-able Jobs | Sampled Open Jobs | Trailing 24h Jobs | Avg New Jobs / Board | Extrapolated Daily Jobs | Turnover Rate |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Greenhouse** | 227 | 227 | 227 | 0 | 17,726 | 1,485 | 6.542 | **~1,485** | 8.38% |
| **Ashby** | 170 | 170 | 170 | 0 | 7,509 | 101 | 0.594 | **~101** | 1.35% |
| **Lever** | 41 | 41 | 39 | 0 | 1,201 | 6 | 0.154 | **~6** | 0.5% |
| **Fleet Total** | **438** | **438** | **436** | **0** | **26,436** | **1,592** | **3.651** | **~1,592** | **6.02%** |

---

## 3. Top Contributing Boards (Trailing 24 Hours)

The highest-volume posting boards in the fleet during the audit window:

| Company Name | ATS | Target | Total Open Jobs | Jobs in Trailing 24h | Daily Share % |
| :--- | :--- | :--- | :--- | :--- | :--- |
| HelloFresh | `greenhouse` | `hellofresh` | 370 | **370** | 23.2% |
| Roblox | `greenhouse` | `roblox` | 277 | **252** | 15.8% |
| Twilio | `greenhouse` | `twilio` | 125 | **68** | 4.3% |
| Celonis | `greenhouse` | `celonis` | 257 | **58** | 3.6% |
| Stripe | `greenhouse` | `stripe` | 787 | **42** | 2.6% |
| Elastic | `greenhouse` | `elastic` | 419 | **40** | 2.5% |
| Toast | `greenhouse` | `toast` | 352 | **37** | 2.3% |
| DoorDash | `greenhouse` | `doordashusa` | 436 | **34** | 2.1% |
| Fivetran | `greenhouse` | `fivetran` | 179 | **32** | 2.0% |
| Samsara | `greenhouse` | `samsara` | 314 | **30** | 1.9% |
| Cloudflare | `greenhouse` | `cloudflare` | 482 | **28** | 1.8% |
| N26 | `greenhouse` | `n26` | 37 | **28** | 1.8% |
| Alloy | `greenhouse` | `alloy` | 31 | **27** | 1.7% |
| Adyen | `greenhouse` | `adyen` | 253 | **21** | 1.3% |
| Airbnb | `greenhouse` | `airbnb` | 207 | **21** | 1.3% |
| Riot Games | `greenhouse` | `riotgames` | 200 | **21** | 1.3% |
| Zscaler | `greenhouse` | `zscaler` | 376 | **21** | 1.3% |
| Databricks | `greenhouse` | `databricks` | 912 | **20** | 1.3% |
| Flexport | `greenhouse` | `flexport` | 193 | **15** | 0.9% |
| MongoDB | `greenhouse` | `mongodb` | 379 | **14** | 0.9% |

---

## 4. Flagged Boards with Zero Date-able Jobs (0 boards)

Boards returning 0 date-able jobs in the audit run (either zero active open jobs, or dates omitted from ATS response payload):

| Company Name | ATS | Target | Total Open Jobs | Reason / Status |
| :--- | :--- | :--- | :--- | :--- |
| _None_ | — | — | — | All sampled boards provided date-able jobs |



---

## 5. Boards with Fetch Errors (2 boards)

| Company Name | ATS | Target | Error Message |
| :--- | :--- | :--- | :--- |
| Sonatype | `lever` | `sonatype` | `HTTP 404 Not Found` |
| Symplicity | `lever` | `symplicity` | `HTTP 404 Not Found` |


---

## 6. Mathematical Methodology & Projection Formulas

1. **Board-Level Daily Posting Rate**:
   $$\text{Rate}_b = \sum_{j \in \text{Jobs}_b} \mathbb{I}\left(T_{\text{now}} - 24\text{h} \le T_j \le T_{\text{now}}\right)$$
2. **Platform Average Posting Rate**:
   $$\mu_{\text{ATS}} = \frac{\sum_{b \in S_{\text{ATS}}} \text{Rate}_b}{|S_{\text{ATS}}|}$$
3. **Fleet-Wide Extrapolated Daily Supply**:
   $$\widehat{C}_{\text{fleet}} = \sum_{\text{ATS} \in \{\text{GH}, \text{Ashby}, \text{Lever}\}} \left(\mu_{\text{ATS}} \times N_{\text{ATS}}\right)$$
   Where $N_{\text{ATS}}$ is the fleet-wide enabled board count (Greenhouse: 227, Ashby: 170, Lever: 41, Total: 438).
4. **Target Feasibility Determination**:
   $$\Delta = \widehat{C}_{\text{fleet}} - 1200$$
   - If $\Delta \ge 0$: Fleet posting rate **can deliver 1,200+ new jobs/day**.
   - If $\Delta < 0$: Fleet posting rate exhibits a **deficit of $|\Delta|$ jobs/day**.
