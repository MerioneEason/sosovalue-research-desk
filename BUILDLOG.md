# BUILDLOG — SoSoValue Research Desk, skeleton + core build

Date: 2026-11-16. Scope: local build only. No GitHub repo created, nothing
pushed, nothing submitted anywhere. API key not yet issued — the whole
pipeline runs on the sample fallback, as designed.

## What was built

```
main.ts               pipeline: gather → board + backtest → static site (dist/)
lib/sosovalue.ts      SoSoValue client: documented endpoints, {code,message,data}
                      unwrap, 3.05s live-request spacing (docs: 20 req/min/key),
                      disk cache (.cache/, 6h TTL), sample fallback, key only
                      from SOSO_API_KEY env, never written anywhere
lib/model.ts          research score + board builder + data.js writer
                      (skeleton adapted from the Launch Radar model)
lib/strategy.ts       dip-bounce core extracted from the race bot's
                      Bot.decide() (no NDJSON wire layer) + backtest driver
dashboard/            index.html / app.js / app.css — radar shell adapted,
                      four views: Research board | Signals & backtest |
                      ETF flows | Indices; detail dialog per asset with
                      in-page score recomputation check
data/sample.json      synthetic fallback snapshot (see provenance below)
tools/make-sample.mjs deterministic generator of data/sample.json
```

make.fun bindings stripped as instructed: no vendor/makefun-board.ts, no
.makefun/, no README badges or referral links, no dossier/screenshot gate
logic; LICENSE copyright line replaced with this project's contributors.

## Sample data provenance (honesty note)

`data/sample.json` is **synthetic**: produced by `tools/make-sample.mjs`
(mulberry32 seeded PRNG, fixed seed → byte-identical regeneration).
Payload *shapes* mirror the documented API responses field for field;
values are invented and are not market data. BTC's path is deliberately
shaped with two sell-off/bounce episodes so the backtest exercises the
strategy. Every build stamps its data source (`live` / `mixed` /
`sample`) into data.js, board.json's sibling output and the dashboard
banner.

## Run record

Command: `node main.ts --offline` (Node v24.22.1), exit 0:

```
research desk: 10 assets tracked, 10 ranked, 2 indices, backtest 2 round trips, return 12.63%
research desk: data source = sample, total market cap $2.28T
research desk: wrote board.json, data.js and dashboard/ (3 files) in .../sosovalue-build/dist
```

A second run without `--offline` and without a key produced a
byte-identical `board.json` (determinism check passed).

Generated demo files:

```
dist/board.json            ranked board (10 rows)
dist/data.js               window.SOSO dataset
dist/dashboard/index.html
dist/dashboard/app.js
dist/dashboard/app.css
```

Board (sample data): SOL 50 · DOGE 47 · AVAX 47 · BTC 45 · ETH 45 ·
XRP 44 · ADA 43 · LINK 41 · DOT 40 · LTC 38.

Backtest on sample BTC daily bars (DAILY_PARAMS, $10,000 paper):
strategy +12.63% vs buy-and-hold +3.04%, max drawdown 0.14%, 2 round
trips, win rate 100%, exposure 29% of days.
Trades: BUY 2026-09-29 @ 89,382 → SELL 2026-10-13 @ 98,631
(take-profit, +10.02%); BUY 2026-11-03 @ 91,851 → SELL 2026-11-15
@ 99,032 (end-of-data, +7.50%).

## Verification performed

- `node --check` on dashboard/app.js and tools/make-sample.mjs: clean.
- Score self-check: the dashboard's restated formula was recomputed
  against every board row in Node — 0 mismatches (score and momentum).
- Headless Chromium (puppeteer chrome-headless-shell) rendered all four
  views from file:// — board, signals (trade reasons visible), ETF,
  indices — plus the asset detail dialog via deep link `#p=btc`,
  which shows "Page recomputes — matches". No JS errors.
  (The system /opt/meta-chromium binary refuses headless use outside
  its policy; the puppeteer shell was used instead.)
- Secret self-check over the whole tree: no keypair / claim / secret /
  private-key material; the only `api_key`-shaped strings are the
  documented header name and the SOSO_API_KEY env var. No make.fun
  residue (grep clean).

## Doc facts that shaped the code (docs read 2026-11-16)

Source: https://sosovalue-1.gitbook.io/sosovalue-api-doc — Introduction,
Endpoint Overview, Response Format, Rate Limit, and pages 1.1, 1.3, 1.5,
2.1, 3.1, 3.2, 10.1.

1. **Klines are daily only** (`interval=1d`, most recent 3 months,
   limit ≤ 500). The race bot ran on 1-minute bars, so its parameters
   could not be carried over numerically: `lib/strategy.ts` exports the
   originals as `RACE_PARAMS_1M` (provenance) and a rescaled
   `DAILY_PARAMS` (lookback 20d, dip −8%, TP +10% / SL −5%, max hold
   20d, cooldown 5d; stake 70% and the rule shape unchanged).
2. **Envelope vs payload**: endpoint pages show bare payloads, the
   Response Format page defines a `{code, message, data}` wrapper. The
   client unwraps when `code` is present and tolerates a bare payload.
3. **Rate limit**: 100k/month and 20/minute per key; 429 → code 42901.
   Client spaces live requests ≥ 3.05s and caches aggressively.
4. **ETF summary-history**: requires `symbol` + `country_code`, most
   recent 1 month only, distinct error codes for bad enum (400003) vs
   unlisted combination (400001); client surfaces code + message.
5. **/market/overview**: numbers are strings; any field may be omitted
   when its source is down — all fields treated as optional.
6. **Doc quirks noted**: the same example `currency_id`
   (1673723677362319867) appears as ETH in the list example and as BTC
   in the constituents example — sample data uses distinct ids per
   asset (ETH keeps the documented one). `change_pct_24h` in 1.3 is not
   explicitly defined as percent vs fraction; the 10.1 page defines its
   own change field as a percentage, and this project interprets 1.3's
   field the same way (values like −1.23 mean −1.23%).

## Known limits / next steps

- Live mode was untested when this section was first written; it has
  since been verified end to end — see "Live integration" below.
- `indexSnapshot` (docs 3.3) is implemented in the client but unused by
  the pipeline and has no sample payload (throws if called offline).
- Dashboard has no index-detail sparkline for index klines (docs 3.4)
  yet; ETF view covers BTC/ETH US only.
- No git repo initialised (per instructions); dist/ and .cache/ are
  gitignored for when it is.

## Live integration (2026-11-16, API key issued)

The key was loaded from its vault file into the SOSO_API_KEY env var
only (never written into the project; full-tree scan below). Call
budget for the whole session: ~50 requests (10 probe + 38 first
pipeline run + 2 on the re-run, the other 36 served from cache) —
far under the 10,000/month free quota, and the client's 3.05s spacing
kept the rate under 20/minute throughout. No auth or paywall surprises:
every endpoint answered HTTP 200 with code 0 on the free key.

### Endpoints verified against live responses (all 7 the pipeline uses)

- GET /currencies — 1,201 entries; fields exactly as documented; all
  10 tracked symbols present (matched by the pipeline, so list size
  costs nothing extra).
- GET /currencies/{id}/market-snapshot — all documented fields
  present; money fields are JSON numbers, supplies are strings,
  ath_date / cycle_low_date are epoch-ms strings.
- GET /currencies/{id}/klines — exactly `limit` daily bars, ascending;
  see discrepancy 2 for the field types.
- GET /etfs/summary-history — fields as documented; see
  discrepancy 5 for the row count.
- GET /indices — 13 tickers (ssiDeFi … ssiGameFi).
- GET /indices/{ticker}/constituents — weights are fractions summing
  to 1.0 (ssiDeFi checked exactly); 112 constituents across 13 indices.
- GET /market/overview — all numbers as strings, as documented.

### Discrepancies found and fixed

1. **Snapshot ratios are fractions, not percents.** Live BTC:
   change_pct_24h −0.0188, cross-checked against the kline-implied
   daily move (−1.55%; the difference is rolling-24h vs UTC-day
   windows) — so −0.0188 means −1.88%, not −0.0188%. down_from_ath
   0.49 equals 1 − price/ATH to four decimals (a *positive* fraction);
   up_from_cycle_low 0.11 means +11%. The skeleton (and its sample)
   assumed percent scale. Fix: lib/model.ts converts both fields
   ×100 into the board's *_pct fields; client types widened to
   `number | string` with the convention documented. Note the trap:
   /market/overview's total_market_cap_change_pct is genuinely
   percent-scale ("-1.51532725" = −1.51%) — the two conventions
   coexist and were deliberately not unified.
2. **Kline `timestamp` and `volume` are strings** ("1787097600000",
   "29054"), not the numbers the interface declared. Left unfixed,
   the dashboard's `new Date(t)` on a numeric string is an Invalid
   Date and its trade-date rendering throws. Fix: currencyKlines()
   in lib/sosovalue.ts coerces every field with Number(); idempotent
   for cache and sample payloads.
3. **Symbol case collision in /currencies.** The list holds both
   "doge" (Dogecoin) and "DOGE" (Department Of Government
   Efficiency, marketcap rank 975, price
   $0.001003). main.ts keyed its map by lowercased symbol, so the
   later entry silently won and the first live board ranked the
   wrong token. Fix: first entry wins, and an exact-case symbol
   beats a case variant seen earlier. DOGE now boards as Dogecoin
   ($0.0584, ssiMAG7 + ssiMeme member).
4. **Envelope carries a fourth field**, `details: null`, beside
   { code, message, data }. Harmless; noted in the client header.
5. **ETF summary-history returns ~20 rows for limit=50** — one month
   of trading days is all the endpoint serves, newest first. The
   dashboard already sorts by date itself; no change needed.
6. **The sample generator encoded the wrong conventions** (percent
   ratios, negative-string down_from_ath, numeric kline
   timestamp/volume, lowercase index tickers). Regenerated to mirror
   the live shapes — fraction ratios, string timestamp/volume,
   ssiMAG7/ssiLayer1 — so offline builds exercise the same code
   paths. Offline re-check: sample BTC row now reads +0.55% 24h and
   21.53% down-from-ATH as originally intended, and the sample
   backtest is unchanged (+12.63%, 2 round trips).

### indexSnapshot (docs 3.3) — verified, deliberately unused

Probed live: returns price, change_pct_24h and roi_7d/1m/3m/1y + ytd,
all fractions. The indices view is constituents-only and needs none
of it, so the pipeline does not call it; the client method stays
(documented as such) and still has no sample payload.

### Live demo (dist/, built 2026-11-16)

- Data source = **live** (no sample fallback fired; source_note says
  so and the dashboard banner renders in its live variant).
- Board: 10 assets ranked — BTC 24 · ETH 23 · LINK 23 · LTC 21 ·
  XRP 20 · SOL 20 · DOGE 20 · AVAX 20 · ADA 19 · DOT 17, all stance
  "weak", all high confidence: a broad drawdown (30d returns −21% to
  −35%, prices 49–99% below ATH). Total market cap $2.18T, −1.51%
  24h (overview figure, percent-scale as documented).
- Backtest on live BTC daily bars, 2026-08-19 → 2026-11-16 (90
  bars): **0 round trips** — strategy 0.00% vs buy-and-hold −7.14%,
  max drawdown 0%. Verified this is the strategy being correct, not
  a wiring bug: no bar in the window satisfies the entry rule (the
  deepest 20-day dip, −20.4%, is the final bar, where the 3-day
  turn is still −5.75% — the bounce the rule waits for has not
  happened yet).
- ETF view: BTC and ETH complexes, 20 trading days each
  (2026-10-19 → 2026-11-13).
- Render verification: chrome-headless-shell over CDP, 22 DOM
  assertions across board / BTC detail dialog / signals / ETF
  (BTC+ETH) / indices — all pass, zero console errors or exceptions.
  The detail dialog's in-page score recomputation reports "matches"
  on live data, and Down-from-ATH renders 49.0%.

### Secret re-check after live runs

The key value was scanned for across all 59 project files (including
.cache/ and dist/): 0 hits. No .env exists in the project; the only
api_key-shaped strings remain the documented header name and the
SOSO_API_KEY env var. .cache/ and dist/ stay gitignored.

## Multi-asset signals + submission polish (2026-11-16, later)

Motivation: on live data the single BTC backtest showed 0 trades
(verified correct behaviour in a one-way drawdown), which left the
demo's signals view looking empty. The fix was breadth and evidence,
not parameter changes — `DAILY_PARAMS` and the strategy rule are
untouched, and the sample BTC backtest still reproduces +12.63% /
2 round trips exactly.

- **Multi-asset backtests.** main.ts now runs the same unmodified
  rules over every tracked asset's klines (already fetched for the
  board — zero extra API calls), in board-rank order.
  `ResearchData.backtest` became `backtests: AssetBacktest[]`.
  Live result: ETH 2rt/−7.85%, LINK 2rt/−8.61%, LTC 3rt/−17.43%,
  XRP 3rt/−0.20%, SOL 2rt/−10.96%, DOGE 3rt/−11.44%, AVAX 2rt/−10.27%,
  ADA 3rt/−14.63%, DOT 1rt/−4.24% — 21 round trips across 9 assets —
  and BTC 0rt/0.00% vs buy-and-hold −7.14%.
- **Signal diagnostics** (`signalDiagnostics` in lib/strategy.ts):
  per asset, evaluated bars, raw entry-predicate hits, deepest
  lookback dip, and the closest miss with its shortfall. BTC live:
  70 bars evaluated, 0 hits; deepest 20-day dip −20.4% on the final
  bar (2026-11-16) with the 3-day turn at −5.75%; closest miss
  2026-11-09 (dip −9.2%, turn −0.63%), short 0.83 pts on the turn.
  The dashboard's signals view gained an asset switcher, an
  all-assets summary table, and a "stood aside" panel rendering this
  scan whenever the selected asset has no trades.
- **Score-scale check.** The research score is absolute by
  construction (each asset's own returns/position; fixed 65/50/35
  bands; no cross-asset normalisation), so the all-weak live board
  (17–24) is the model reporting a broad drawdown, not a defect.
  Documented in the lib/model.ts header, the dashboard's model strip,
  and the README.
- **Docs.** README finalised (features, endpoint map, screenshots,
  stand-aside explanation); `tools/capture.mjs` added (chrome-headless-
  shell, 1440×900) and four live-build screenshots written to docs/
  and visually inspected — public market data only, nothing sensitive;
  `CHANGELOG-wave3.md` (the Wave 3 progress log AKINDO asks for) and
  `SUBMISSION.md` (Project Overview + Team Information draft; repo and
  demo URLs left as placeholders) written.
- **Final verification.** Live pipeline re-run end to end (all
  payloads served from the 6h cache, so 0 new API requests this run;
  source still stamps `live`), exit 0; headless DOM renders of all
  four views plus the BTC detail dialog and the BTC signals deep link
  all contain their expected content ("stood aside" panel, "Page
  recomputes — matches"); sample-mode rebuild verified separately
  (source `sample`, BTC +12.63%/2rt unchanged, other assets 0 trades
  with diagnostics). Secret scan over all 66 project files: 0 hits
  for the key value, 0 for the account email; only the documented
  header name and the SOSO_API_KEY env var remain.

## GitHub publication (2026-11-16)

Pre-push scan repeated independently over the whole tree (including
`.cache/`): the API key value from the local credential file and the
account email both returned **0 hits**; no keypair / claim-code /
private-key material anywhere. (Two false-positive classes only: the
key's human-readable *name* label, shared with the project title, and
a date string; plus the word "Secret" as the SCRT token name inside a
cached currency list — the cache is gitignored regardless.)

- Repo: https://github.com/MerioneEason/sosovalue-research-desk
- `main` — source tree (21 files; `.cache/` and `dist/` gitignored):
  commit `19e03495c13aa5985d57e294606a3e64018ca88f`
- `gh-pages` — `dist/` contents at branch root (`data.js`,
  `board.json`, `dashboard/{index.html,app.js,app.css}`; the page
  loads `../data.js`, so this layout is load-bearing):
  commit `9dc6bf0cedfdae4be972a577f05e7fdc6cb7c776`
- Verified with `git ls-remote`: HEAD → main commit, both branch
  refs present and pointing at the commits above. Pages enablement
  in repo settings is handled separately (not done here).

## Submission links filled in (2026-11-16)

`SUBMISSION.md`: the Repository and Live demo placeholders replaced
with the verified live links (repo:
https://github.com/MerioneEason/sosovalue-research-desk ; demo:
https://merioneeason.github.io/sosovalue-research-desk/dashboard/),
and the optional Video introduction line resolved to "not provided".
Full read-through: no remaining placeholders, no API key or email
address anywhere in the file. `README.md` checked — it contains no
repo/demo placeholders (nothing to replace).

- Commit `9962d53971c8b1a39121a5448ddf10650f3decdb` on `main`
  ("Fill in repo and demo links for Wave 3 submission"; also carries
  the GitHub-publication section above), pushed and confirmed via
  `git ls-remote`: `refs/heads/main` → that commit, `gh-pages`
  unchanged at `9dc6bf0cedfdae4be972a577f05e7fdc6cb7c776`.
