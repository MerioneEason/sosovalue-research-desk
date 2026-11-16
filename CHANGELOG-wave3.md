# Wave 3 Progress — SoSoValue Research Desk

AKINDO × SoSoValue WaveHack, Wave 3 (submission deadline 2026-11-27).
Project: **SoSoValue Research Desk** — a Smart Research Dashboard +
Signal-to-Execution desk built entirely on the SoSoValue OpenAPI.

## 2026-11-16

### Skeleton + core build
- Project skeleton assembled from two earlier works of the author, with
  all previous-event bindings stripped: the research-board shell and
  scoring discipline of a token-launch radar, and the dip-bounce strategy
  core of a live cbBTC race bot (extracted as a pure function; the wire
  protocol and harness removed, original 1-minute parameters preserved
  in source for provenance).
- `lib/sosovalue.ts`: SoSoValue client written against the official docs
  — `{code, message, data}` envelope unwrap, request spacing under the
  documented 20 req/min per key, on-disk response cache (6h TTL), and a
  bundled sample snapshot fallback (synthetic values, documented shapes)
  so the pipeline runs end to end with no key.
- `lib/model.ts`: research score (momentum / position / liquidity) over
  10 tracked majors; board builder; `data.js` writer. The dashboard
  restates the formula and recomputes every row's score in-page as a
  self-check.
- `lib/strategy.ts`: backtest driver over BTC daily klines with a daily
  rescale of the race parameters (`DAILY_PARAMS`), documented as an
  adaptation — the API serves daily klines only.
- Dashboard: four views (research board, signals & backtest, ETF flows,
  indices) as a fully static site; one Node command builds it, no
  dependencies, no build step.

### Live integration (API key issued, free developer tier)
- All 7 endpoints the pipeline uses verified against live responses
  (currencies, market snapshot, klines, ETF summary history, index list,
  index constituents, market overview). Whole session ≈ 50 requests,
  far under the 10,000/month free quota.
- Six doc-vs-live discrepancies found and fixed, each recorded in
  `BUILDLOG.md`: snapshot ratios are fractions not percents (while
  `/market/overview`'s change field is percent-scale — the conventions
  coexist and are deliberately not unified); kline `timestamp`/`volume`
  arrive as strings and are coerced in the client; a symbol case
  collision in `/currencies` ("doge" vs "DOGE" are different tokens)
  is resolved first-wins with exact-case preference; the envelope
  carries a fourth field (`details: null`); ETF history returns ~20
  trading days regardless of `limit=50`; the sample generator was
  regenerated to mirror the live shapes so offline builds exercise the
  same code paths.
- First live build: board of 10 assets (all stance *weak* in a broad
  drawdown, 30-day returns −21% to −35%), ETF tape for BTC/ETH US,
  13 indices with 112 constituents; 22 headless DOM assertions pass,
  zero console errors; the detail sheet's in-page score recomputation
  matches on live data.

### Multi-asset signal engine + submission polish
- The backtest now runs the **same unmodified rules** over every
  tracked asset's daily klines (reusing the klines the board already
  fetched — zero extra API calls), presented in board-rank order with
  an asset switcher and an all-assets summary table.
- New `signalDiagnostics` in `lib/strategy.ts`: for every asset, bars
  evaluated, raw entry-predicate hits, deepest lookback dip, and the
  closest miss (which entry condition fell short, and by how much).
  The signals view renders this whenever an asset has no trades, so a
  quiet asset shows the engine's scan instead of an empty table.
- Live result on the day: 9 of 10 assets traded (21 round trips);
  BTC stood aside — 0 predicate hits in 70 evaluable bars, deepest
  20-day dip −20.4% on the final bar with the 3-day turn still −5.75%,
  closest miss 2026-11-09 short 0.83 pts on the turn. No parameter was
  retuned to change this; the stand-aside is reported as-is (strategy
  0.00% vs buy-and-hold −7.14% on BTC).
- Scoring-scale note: the research score is an **absolute** scale
  (fixed bands, no cross-asset normalisation), so a market-wide
  drawdown correctly reads *weak* across the board. This is now stated
  in the model header, on the dashboard beside the board, and in the
  README, so the all-weak live board is not misread as a defect.
- README finalised (features, endpoint map, scoring scale, signal
  stand-aside explanation); `tools/capture.mjs` added and four
  screenshots from the live build published under `docs/`;
  `SUBMISSION.md` drafted with the AKINDO Project Overview and team
  information.
