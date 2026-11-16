# AKINDO Submission

Submission copy for AKINDO × SoSoValue WaveHack — Wave 3. All links verified live on 2026-11-16.
(submission deadline 2026-11-27 15:00 UTC). Paste into the
AKINDO submission form.

## Project Overview

**Project name:** SoSoValue Research Desk

**Short description:**
A Smart Research Dashboard + Signal-to-Execution desk for a one-person
on-chain finance operator, built entirely on the SoSoValue OpenAPI. It
ranks 10 major crypto assets by one transparent, fully published score,
and replays a disciplined dip-bounce signal engine — extracted from a
live trading bot — over every tracked asset's daily klines as
paper-execution backtests, next to the US spot ETF flow tape and the
full SoSoValue index constituent map. One Node command builds a fully
static site that renders with no network.

**Target users:**
Solo traders, independent researchers and small funds who need a daily
triage desk: where to spend research time today, what the ETF tape is
saying, and what a rules-based signal engine would have done — with
every number traceable to a SoSoValue field and every formula printed
on the page.

**Core logic, APIs and data sources:**
All data comes from the SoSoValue OpenAPI
(`https://openapi.sosovalue.com/openapi/v1`); no other source is used.

- `GET /currencies` — tracked-asset universe, matched by symbol
  (with case-collision handling: "doge" and "DOGE" are different tokens).
- `GET /currencies/{id}/market-snapshot` — price, 24h change, market
  cap, FDV, turnover, ATH / cycle low. Its ratio fields are fractions
  and are converted to percents in the model.
- `GET /currencies/{id}/klines?interval=1d` — 7d/30d returns,
  volatility, sparklines, and the backtest bars for all 10 assets
  (the signal engine reuses these; it makes no extra API calls).
- `GET /etfs/summary-history` (BTC, ETH; US) — daily net inflow,
  traded value and net assets for the US spot ETF complexes.
- `GET /indices` + `GET /indices/{ticker}/constituents` — index
  membership and weights for all 13 SoSoValue indices.
- `GET /market/overview` — total market cap, 24h volume, gas snapshot
  (its change field is percent-scale, unlike the snapshot's fractions;
  the code keeps the two conventions separate on purpose).

Core logic:

1. **Research score** (`lib/model.ts`) — one absolute-scale function of
   three documented inputs: momentum (0.6·ret30 + 0.4·ret7, clamped),
   position between cycle low and ATH, and turnover liquidity:
   `score = clamp(45 + 30·momentum + 15·(2·position − 1) + 10·liquidity, 0, 100)`.
   The dashboard prints the constants and recomputes every row's score
   in-page as a self-check. Because the scale is absolute, a
   market-wide drawdown reads *weak* across the board — by design.
2. **Signal engine** (`lib/strategy.ts`) — the dip-bounce rule of a
   live race bot as a pure function of a bar series (entry: ≥8% 20-day
   sell-off *and* a 3-day turn up; exits: +10% take-profit / −5%
   stop-loss / 20-day time-stop; 5-day cooldown; 70% stake; 15 bps per
   side), rescaled from the bot's 1-minute parameters to daily bars
   because the API serves daily klines only; the original parameters
   are preserved in source. Identical rules run on every asset — no
   per-asset tuning.
3. **Signal diagnostics** — per asset: bars evaluated, entry-predicate
   hits, deepest dip, closest miss. Assets with no trades show this
   scan (e.g. on the 2026-11-16 live build BTC stood aside with 0
   hits in 70 bars while the other nine assets completed 21 round
   trips), so an empty trade table is evidence, not absence.
4. **Client discipline** (`lib/sosovalue.ts`) — envelope unwrap,
   request spacing under the documented 20 req/min, on-disk cache
   (6h TTL); a full live build costs ~40 requests of the 10,000/month
   free quota, and repeat builds cost none. With no key, a bundled
   synthetic sample snapshot (documented shapes, invented values,
   labelled as such everywhere) runs the whole pipeline offline.

**Repository:** https://github.com/MerioneEason/sosovalue-research-desk
**Live demo:** https://merioneeason.github.io/sosovalue-research-desk/dashboard/
**Video introduction (optional):** not provided

## Team Information

- **MerioneEason** — solo builder (design, data pipeline, model,
  strategy extraction, dashboard).
- GitHub: https://github.com/MerioneEason
- Contact: via GitHub profile.

## Wave Progress Update

See `CHANGELOG-wave3.md` in the repository: skeleton + core build,
live integration with six documented doc-vs-live fixes, and the
multi-asset signal engine with stand-aside diagnostics — all within
Wave 3.
