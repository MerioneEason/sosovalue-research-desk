// Generates data/sample.json — the client's offline fallback snapshot.
//
// The sample is SYNTHETIC data, generated deterministically by this
// script (seeded PRNG, no network). It is not market data and must never
// be presented as such. What it borrows from the real API is only the
// *shape*: every payload mirrors the documented response fields of the
// SoSoValue OpenAPI (see lib/sosovalue.ts for the doc references), so the
// whole pipeline — client, model, backtest, dashboard — runs end to end
// before an API key exists, and runs identically with live data later.
//
// BTC's path is deliberately shaped with two sell-off-and-bounce episodes
// so the dip-bounce backtest has something real (for a backtest) to do.
// Everything else is a seeded random walk.
//
// Run: node tools/make-sample.mjs   (writes data/sample.json)

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// mulberry32: tiny deterministic PRNG.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const END = Date.UTC(2026, 10, 15); // last sample day: 2026-11-15
const DAYS = 90;

// symbol, name, currency_id, start price, circ. supply, ATH, cycle low,
// daily vol, base drift. Ids are placeholders in the documented format
// (the docs' own examples reuse one id across pages); ETH keeps the id
// shown in the official currency-list example.
const ASSETS = [
  ['btc', 'Bitcoin', '1673723677362319868', 96500, 19_950_000, 126_200, 74_800, 0.011, 0.0006],
  ['eth', 'Ethereum', '1673723677362319867', 3350, 120_700_000, 4_950, 2_180, 0.014, 0.0004],
  ['sol', 'Solana', '1673723677362319869', 205, 489_000_000, 295.8, 96.5, 0.02, 0.0002],
  ['xrp', 'XRP', '1673723677362319870', 2.35, 57_000_000_000, 3.65, 1.28, 0.016, 0.0003],
  ['doge', 'Dogecoin', '1673723677362319871', 0.31, 147_000_000_000, 0.62, 0.145, 0.022, 0.0001],
  ['ada', 'Cardano', '1673723677362319872', 0.92, 35_900_000_000, 2.35, 0.42, 0.017, 0.0002],
  ['link', 'Chainlink', '1673723677362319873', 21.5, 657_000_000, 48.9, 10.8, 0.019, 0.0002],
  ['avax', 'Avalanche', '1673723677362319874', 37.5, 408_000_000, 65.2, 19.4, 0.02, 0.0001],
  ['dot', 'Polkadot', '1673723677362319875', 7.1, 1_530_000_000, 15.8, 3.9, 0.016, 0.0001],
  ['ltc', 'Litecoin', '1673723677362319876', 104, 76_000_000, 245, 58, 0.015, 0.0002],
];

// BTC drift by day index: calm rise, hard sell-off, bounce, drift,
// second sell-off, recovery into the end of the window.
function btcDrift(i) {
  if (i < 25) return 0.0015;
  if (i < 40) return -0.0085;
  if (i < 50) return 0.009;
  if (i < 62) return 0.002;
  if (i < 75) return -0.008;
  return 0.008;
}

const round = (n, d = 6) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

const currencies = [];
const snapshots = {};
const klines = {};

ASSETS.forEach(([symbol, name, id, start, circ, ath, cycleLow, vol, drift], ai) => {
  currencies.push({ currency_id: id, symbol, name });
  const rand = rng(20261116 + ai * 977);
  const bars = [];
  let price = start;
  for (let i = 0; i < DAYS; i++) {
    const d = symbol === 'btc' ? btcDrift(i) : drift;
    const shock = (rand() * 2 - 1) * vol;
    const open = price;
    const close = price * (1 + d + shock);
    const high = Math.max(open, close) * (1 + rand() * vol * 0.5);
    const low = Math.min(open, close) * (1 - rand() * vol * 0.5);
    const volume = round((symbol === 'btc' ? 28e9 : 1.2e9) * (0.6 + rand() * 0.9), 2);
    bars.push({
      // Live klines carry timestamp and volume as strings (verified
      // 2026-11-16); the sample mirrors that so offline runs exercise
      // the same client normalisation as live runs.
      timestamp: String(END - (DAYS - 1 - i) * DAY),
      open: round(open, 4), high: round(high, 4), low: round(low, 4), close: round(close, 4),
      volume: String(Math.round(volume)),
    });
    price = close;
  }
  klines[id] = bars;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const marketcap = last.close * circ;
  snapshots[id] = {
    price: round(last.close, 4),
    // Live snapshot ratios are fractions, not percents (verified
    // 2026-11-16): change -0.0188 means -1.88%, down_from_ath 0.49
    // means 49% below the ATH. The sample follows the live convention.
    change_pct_24h: round((last.close / prev.close) - 1, 4),
    turnover_24h: round(Number(last.volume) * (0.85 + (ai % 5) * 0.07), 2),
    turnover_rate: round(Number(last.volume) / marketcap, 4),
    high_24h: last.high,
    low_24h: last.low,
    marketcap: round(marketcap, 2),
    fdv: round(last.close * circ * 1.18, 2),
    max_supply: symbol === 'btc' ? '21000000' : null,
    total_supply: String(Math.round(circ * 1.05)),
    circulating_supply: String(circ),
    ath,
    ath_date: String(Date.UTC(2025, 9, 14)),
    down_from_ath: round(1 - last.close / ath, 4),
    cycle_low: cycleLow,
    cycle_low_date: String(Date.UTC(2026, 3, 7)),
    up_from_cycle_low: round(last.close / cycleLow - 1, 4),
    marketcap_rank: ai + 1,
  };
});

// ETF summary history (docs 2.1 shape), most recent 30 trading days,
// reverse chronological, weekends skipped.
function etfSeries(seed, baseAssets, baseCum, volUsd) {
  const rand = rng(seed);
  const rows = [];
  let cum = baseCum;
  let assets = baseAssets;
  let t = Date.UTC(2026, 10, 13); // Friday 2026-11-13
  while (rows.length < 30) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const inflow = round((rand() * 2 - 0.82) * volUsd, 2);
      cum += inflow;
      assets = Math.max(assets + inflow, baseAssets * 0.8);
      rows.push({
        date: d.toISOString().slice(0, 10),
        total_net_inflow: inflow,
        total_value_traded: round(volUsd * (6 + rand() * 5), 2),
        total_net_assets: round(assets, 2),
        cum_net_inflow: round(cum, 2),
      });
    }
    t -= DAY;
  }
  return rows;
}

const bySymbol = Object.fromEntries(currencies.map((c) => [c.symbol, c.currency_id]));
const w = (symbol, weight) => ({ currency_id: bySymbol[symbol], symbol, weight });

const bundle = {
  note:
    'SYNTHETIC sample snapshot generated by tools/make-sample.mjs (seeded, deterministic). ' +
    'Payload shapes mirror the SoSoValue OpenAPI documentation; the values are invented ' +
    'and are NOT market data. Used only as the offline fallback until SOSO_API_KEY is set.',
  currencies,
  snapshots,
  klines,
  etf_summary_history: {
    'BTC:US': etfSeries(4242, 118e9, 58e9, 340e6),
    'ETH:US': etfSeries(777, 21e9, 13.5e9, 130e6),
  },
  indices: ['ssiMAG7', 'ssiLayer1'],
  index_constituents: {
    ssiMAG7: [w('btc', 0.31), w('eth', 0.22), w('sol', 0.12), w('xrp', 0.09), w('doge', 0.07), w('ada', 0.06), w('link', 0.05), w('avax', 0.05)],
    ssiLayer1: [w('eth', 0.3), w('btc', 0.16), w('sol', 0.15), w('avax', 0.11), w('dot', 0.09), w('link', 0.08), w('ltc', 0.06)],
  },
  // Values as shown in the docs 10.1 response example.
  market_overview: {
    total_market_cap: '2280614829402.85',
    total_market_cap_change_pct: '0.6',
    total_volume_24h: '40122576829.22',
    eth_gas_gwei: '0.126601389',
    btc_gas_sat_vb: '6',
    as_of: END,
  },
};

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'sample.json');
writeFileSync(out, JSON.stringify(bundle, null, 1) + '\n');
console.log(`wrote ${out}: ${currencies.length} currencies, ${DAYS} daily bars each, 2 ETF series x30, 2 indices`);
