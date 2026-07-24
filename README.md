# AuditForge

**A Screaming Frog audit verification and reporting engine.** Upload a crawl export; AuditForge detects every derivable SEO issue, then — before anything reaches the report — **re-verifies each flagged URL against the live site**, classifying it as `CONFIRMED` (with a source-code evidence snippet), `RESOLVED` (fixed since the crawl), or `UNVERIFIABLE` (with the failure reason, never silently dropped). Confirmed issues are impact-scored, explained by the AI layer, and delivered as a team-ready report with XLSX / Jira CSV / redirect-map / PDF exports.

> **Accuracy over speed, evidence over assumption: nothing enters the report without surviving the verification loop.**

---

## What's fully implemented in this build (v1)

| Area | Status |
|---|---|
| CSV / XLSX ingestion ("Internal: All"), browser-side stream parsing, 50k+ URLs | ✅ first-class |
| `.dbseospider` best-effort SQLite ingestion → graceful CSV-path fallback message | ✅ |
| Detection engine: 24 rules (4xx/5xx, redirect chains/loops/302s, titles, metas, H1/H2, canonical conflicts, noindex+inlinks, orphans, depth, thin content, slow responses…) | ✅ |
| **Verification loop**: live fetch, UA, ≤5 redirect hops, 10s timeout, 1 retry, robots.txt respected, 300ms delay, batched + concurrency-capped + resumable (client-driven `/api/verify` batches — no serverless timeout can kill a 10k-URL run) | ✅ |
| **Link-jump verification**: same-origin links are extracted from the live HTML of every verified page, then (a) cross-checked against the crawl — live pages still linking to known 4xx/5xx URLs become `Live page links to a broken URL` findings — and (b) links *absent from the crawl* are live-checked too (capped at 100/audit); broken ones enter the report as `Broken URL discovered via link jump` | ✅ |
| GSC enrichment via **Search Console "Pages" CSV export** → traffic-weighted Impact Scores, money leaks | ✅ |
| Module B — Core Web Vitals via PSI API, template-clustered sampling | ✅ |
| Module C — Sitemap intelligence (index recursion, 3-way diff, lastmod plausibility, size limits) | ✅ |
| Module D — Internal PageRank, equity leaks, dead-ends, top linking opportunities | ✅ |
| Module F — Delta audits (new / fixed / **regressed**, health trend) via previous-audit JSON | ✅ |
| Module G — Fix tracker: Open → In Progress → Fixed-Claimed → **Fixed-Verified only when live source proves it** (on-demand re-verification; cron recipe below) | ✅ |
| Module I — URL hygiene (parameter bloat, case/slash/protocol dupes, infinite spaces) + **live robots.txt simulator** | ✅ |
| Module J — Header audit piggybacked on verification fetches (HSTS, X-Robots-Tag conflicts, compression, cache-control, charset) | ✅ |
| Module M — Collapsed redirect map (nginx / .htaccess / Next.js) + Jira-importable CSV | ✅ |
| AI layer — batched-by-type explanations, root cause, fix steps + code snippets, effort, owner; executive summary with grade & 30-day plan; **only CONFIRMED issues reach the AI** | ✅ |
| Report — health dashboard, severity & team tabs, verification log, evidence snippets, full appendix, shareable unguessable-slug links (Vercel KV), print-optimized PDF | ✅ |
| Engineering bar — TypeScript + Zod on every API boundary, per-module failure isolation with "module skipped" notes, rate limiting, upload validation, localStorage resume | ✅ |

## Deliberately deferred to v2 (and why)

Being straight with you rather than shipping façades:

- **GSC OAuth + URL Inspection API + Module E (cannibalization).** OAuth token storage needs a real user/session model to be safe. v1 gets you ~80% of the value via the GSC Pages CSV upload (30 seconds to export). Cannibalization needs the per-query API dimension, which the CSV lacks. The Google Cloud console setup steps are below so the plumbing is ready.
- **Module A (raw vs rendered DOM).** `puppeteer-core + @sparticuz/chromium` works on Vercel but pins you to specific function memory/size budgets; it deserves its own queue-isolated route rather than a bolted-on afterthought.
- **Module H (simhash near-duplicates), Module K (schema validation), Module L (AEO scoring), Slack digest.** Straightforward extensions on top of the existing verification fetch (the HTML is already in hand at that point in `src/app/api/verify/route.ts`).
- **Server-side PDF.** The report ships a print stylesheet (`⬇ PDF` button → browser print → Save as PDF), which stakeholders can't tell apart from a generated PDF. Headless-Chrome PDF generation belongs with Module A.

---

## File tree

```
auditforge/
├── package.json
├── tsconfig.json
├── next.config.mjs
├── tailwind.config.ts
├── postcss.config.mjs
├── .env.example
├── .gitignore
├── README.md
├── fixtures/
│   ├── sample_internal_all.csv      ← issue-rich test crawl (25 URLs)
│   └── sample_all_inlinks.csv       ← matching All Inlinks export
├── scripts/
│   └── smoke.test.ts                ← npm test: detection/PR/robots/delta assertions
└── src/
    ├── app/
    │   ├── layout.tsx
    │   ├── globals.css              ← dark UI + print/PDF stylesheet
    │   ├── page.tsx                 ← pipeline orchestrator (parse→detect→verify→enrich→modules→analyze→report)
    │   ├── r/[slug]/page.tsx        ← shared read-only report
    │   └── api/
    │       ├── verify/route.ts      ← THE VERIFICATION LOOP (+ Module J headers)
    │       ├── analyze/route.ts     ← OpenAI batched analysis + exec summary
    │       ├── sitemap/route.ts     ← Module C fetcher (index recursion)
    │       ├── robots/route.ts      ← live robots.txt for the simulator
    │       ├── psi/route.ts         ← Module B PageSpeed Insights
    │       └── reports/route.ts     ← shareable links via Vercel KV
    ├── components/
    │   ├── Upload.tsx               ← drag-drop + validation + secondary inputs
    │   ├── Pipeline.tsx             ← live stage/progress display
    │   └── Report.tsx               ← full report UI, exports, fix tracker, robots simulator
    └── lib/
        ├── schema.ts                ← Zod schemas & shared types (the internal crawl schema)
        ├── parse.ts                 ← CSV/XLSX stream parsing, dbseospider, GSC CSV, inlinks
        ├── detect.ts                ← 24-rule detection engine
        ├── analysis.ts              ← impact scores, health, delta, PageRank
        ├── modules.ts               ← hygiene, sitemap diff, redirect map, Jira CSV
        ├── robots.ts                ← robots.txt parser/matcher (server + simulator)
        └── exports.ts               ← XLSX workbook, JSON export, download helpers
```

## Architecture notes (the decisions that matter)

- **Parsing happens in the browser.** Vercel serverless bodies cap at ~4.5MB; large SF exports blow past that. PapaParse streams the CSV chunk-by-chunk in the client — a 50k-URL export never leaves your machine and never hits a function limit. Only *flagged URLs* are sent server-side, in batches of 8.
- **Verification is client-driven and resumable by construction.** The client owns the queue and fires `/api/verify` batches (3 concurrent, 8 URLs each, 300ms server-side delay between URLs, robots.txt cached per origin). Each function invocation stays far under limits regardless of site size; a dropped batch marks its items `UNVERIFIABLE` with the reason instead of dying. Audit state persists to `localStorage` after every mutation — refresh and hit "Resume last audit".
- **Every failure path surfaces a human-readable message**: unsupported file, empty export, sqlite fallback, missing API keys (501s with instructions), robots-blocked URLs, KV not configured, rate limits (429 + client backoff).

---

## Environment variables

Copy `.env.example` → `.env.local`:

| Var | Needed for | Behavior if missing |
|---|---|---|
| `OPENAI_API_KEY` | AI explanations + exec summary | Report ships without AI sections, with a note |
| `OPENAI_MODEL` | optional model override | defaults to `gpt-4o-mini` |
| `PAGESPEED_API_KEY` | Module B | Module skipped with note |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Shareable report links | Share button explains; JSON export still works |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | v2 GSC OAuth | unused in v1 |
| `SLACK_WEBHOOK_URL` | v2 Slack digest | unused in v1 |

## Local test walkthrough (5 minutes, no keys needed)

```bash
npm install
npm test          # smoke tests: detection, PageRank, robots matcher, delta, redirect map
npm run dev       # http://localhost:3000
```

1. Open http://localhost:3000.
2. (Optional but recommended) Under **All Inlinks**, add `fixtures/sample_all_inlinks.csv`.
3. Drag **`fixtures/sample_internal_all.csv`** onto the drop zone.
4. Watch the forge line: parse → detect (~40 flags) → **verify** → link jump (URLs found inside live page source get chased and checked too). The fixture uses `example.com`, so most checks resolve or confirm against the real live site; robots/network failures land in **Unverifiable** with reasons — exactly as designed.
5. Explore: severity/team tabs, evidence snippets (click any row), Module D equity leaks (the fixture links to a 404 from high-PR pages), Module I robots simulator, Module M redirect exports (`/blog/old-post` chain collapses to `/blog/new-post` in 2 hops).
6. Export **Audit JSON**, start a **New audit**, re-upload the same CSV *plus* that JSON as "previous audit" → delta report.
7. Mark an issue **Fixed-Claimed** → "Re-verify claimed fixes" → it's promoted to **Fixed-Verified** only if the live source proves it.
8. Add `OPENAI_API_KEY` to `.env.local`, restart, re-run → AI fix instructions + executive summary appear.

## Vercel deploy

```bash
npm i -g vercel
vercel            # link the project
vercel env add OPENAI_API_KEY        # repeat for PAGESPEED_API_KEY etc.
vercel --prod
```

Or push to GitHub → "Import Project" on vercel.com → framework auto-detected (Next.js 14) → add env vars in **Settings → Environment Variables** → Deploy. Zero further config: `maxDuration = 60` is declared per-route in the code (fits Pro; on Hobby, functions cap at 10s–60s depending on plan — the batch size of 8 with 300ms delay stays inside even 10s for most sites; lower `VERIFY_BATCH` in `src/app/page.tsx` if needed).

**Shareable links:** Vercel dashboard → Storage → Create → **KV (Upstash)** → connect to the project. `KV_REST_API_URL` / `KV_REST_API_TOKEN` are injected automatically. Reports live 90 days at `/r/<unguessable-slug>`.

**Scheduled re-verification (Module G cron):** add to `vercel.json`:

```json
{ "crons": [{ "path": "/api/cron/reverify", "schedule": "0 3 * * *" }] }
```

then create `src/app/api/cron/reverify/route.ts` that loads persisted audits from KV, filters `fixStatus === "Fixed-Claimed"`, and replays them through the same logic as `/api/verify` (all exported and reusable). v1 ships the on-demand button wired to identical code, so the cron route is a ~40-line addition.

## Google Cloud OAuth setup (for the v2 GSC connection — do this once, ahead of time)

1. [console.cloud.google.com](https://console.cloud.google.com) → New project → **APIs & Services → Library** → enable **Google Search Console API**.
2. **OAuth consent screen** → External → add scope `https://www.googleapis.com/auth/webmasters.readonly` → add your team as test users.
3. **Credentials → Create credentials → OAuth client ID** → Web application → Authorized redirect URI: `https://<your-app>.vercel.app/api/gsc/callback` (+ `http://localhost:3000/api/gsc/callback` for dev).
4. Copy client ID/secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

Until then: **Search Console → Performance → Export → Download CSV → upload the `Pages` file** in the AuditForge upload screen. That powers Impact Scores, money leaks, and the sitemap/GSC diff today.

## Extending the detection engine

Add a rule in `src/lib/detect.ts` (one object: id, label, severity, owner, `test(row, ctx)` returning evidence or null), then teach `classify()` in `src/app/api/verify/route.ts` how to re-check it against live HTML. Everything else — impact scoring, report grouping, exports, AI batching — picks it up automatically.
