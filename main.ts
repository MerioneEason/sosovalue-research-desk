// SoSoValue Research Desk entrypoint (Node 22+, standard library only).
//
// Pulls market data through the SoSoValue client (live API when
// SOSO_API_KEY is set, its disk cache when fresh, the bundled sample
// snapshot otherwise), builds the research board with lib/model.ts, runs
// the dip-bounce backtest from lib/strategy.ts over every tracked
// asset's daily klines (the same klines the board already fetched — the
// signal engine costs no extra API calls), and writes a static site:
//
//   board.json    the ranked research board
//   data.js       the dashboard's dataset, written beside dashboard/
//   dashboard/    a copy of this repository's static page
//
// Run it:  node main.ts [--output dist] [--offline]
// The page is a pure function of the payloads it was built from: open
// dist/dashboard/index.html and it renders with no network at all.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SosoClient, num, type DataSource } from './lib/sosovalue.ts';
import {
  buildBoard,
  dataScript,
  MODEL,
  MODEL_VERSION,
  type AssetBacktest,
  type AssetInput,
  type ResearchData,
} from './lib/model.ts';
import { runBacktest, signalDiagnostics, DAILY_PARAMS, type Bar } from './lib/strategy.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The majors this desk tracks, matched by symbol against /currencies. */
const TRACKED_SYMBOLS = ['btc', 'eth', 'sol', 'xrp', 'doge', 'ada', 'link', 'avax', 'dot', 'ltc'];

function option(name: string, envName: string | undefined, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && process.argv[at + 1] !== undefined) return process.argv[at + 1]!;
  const glued = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (glued !== undefined) return glued.slice(name.length + 3);
  if (envName !== undefined && process.env[envName] !== undefined) return process.env[envName]!;
  return fallback;
}

function fail(message: string): never {
  process.stderr.write(`research desk: ${message}\n`);
  process.exit(1);
}

function copyFlat(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    names.push(name);
  }
  return names;
}

const outDir = option('output', 'SOSO_OUTPUT_DIR', join(here, 'dist'));
const offline = process.argv.includes('--offline');
const client = new SosoClient({ offline, verbose: true });

const sources = new Set<DataSource>();
const track = <T>(s: { data: T; source: DataSource }): T => {
  sources.add(s.source);
  return s.data;
};

// ------------------------------------------------------------ gather
const currencies = track(await client.listCurrencies());
// Match tracked symbols case-insensitively, but never let a case
// variant overwrite an exact match: the live list contains both
// "doge" (Dogecoin) and "DOGE" (Department Of Government Efficiency,
// a different token ranked ~975) — a plain lowercase-keyed Map picks
// whichever comes last and silently boards the wrong asset
// (live-verified 2026-11-16). First entry wins; an exact-case symbol
// beats a case variant seen earlier.
const bySymbol = new Map<string, (typeof currencies)[number]>();
for (const c of currencies) {
  const key = c.symbol.toLowerCase();
  const prev = bySymbol.get(key);
  if (prev === undefined || (prev.symbol !== key && c.symbol === key)) {
    bySymbol.set(key, c);
  }
}
const tracked = TRACKED_SYMBOLS.map((s) => bySymbol.get(s)).filter((c) => c !== undefined);
if (tracked.length === 0) fail('none of the tracked symbols appear in /currencies');

const indexTickers = track(await client.listIndices());
const indexData: ResearchData['indices'] = [];
const memberships = new Map<string, { ticker: string; weight: number }[]>();
for (const ticker of indexTickers) {
  const constituents = track(await client.indexConstituents(ticker));
  indexData.push({ ticker, constituents });
  for (const c of constituents) {
    const list = memberships.get(c.currency_id) ?? [];
    list.push({ ticker, weight: c.weight });
    memberships.set(c.currency_id, list);
  }
}

const inputs: AssetInput[] = [];
const barsBySymbol = new Map<string, Bar[]>();
for (const ref of tracked) {
  const snapshot = track(await client.currencySnapshot(ref.currency_id).catch(() => ({ data: null, source: 'sample' as DataSource })));
  const klines = track(await client.currencyKlines(ref.currency_id, 90).catch(() => ({ data: [], source: 'sample' as DataSource })));
  inputs.push({
    ref,
    snapshot,
    klines,
    memberships: memberships.get(ref.currency_id) ?? [],
  });
  barsBySymbol.set(
    ref.symbol.toLowerCase(),
    klines.map((k) => ({ t: k.timestamp, o: k.open, h: k.high, l: k.low, c: k.close, v: k.volume })),
  );
}

const etf: ResearchData['etf'] = {};
for (const symbol of ['BTC', 'ETH']) {
  etf[symbol] = track(
    await client.etfSummaryHistory(symbol, 'US', 50).catch(() => ({ data: [], source: 'sample' as DataSource })),
  );
}
const market = track(await client.marketOverview().catch(() => ({ data: null, source: 'sample' as DataSource })));

// ------------------------------------------------------------ build
const board = buildBoard(inputs);
// One backtest per tracked asset, in board-rank order, all on the same
// unmodified DAILY_PARAMS: in a one-way market some assets will show
// trades and others none, and each result carries the signal
// diagnostics that explain which — and how close the quiet ones came.
const minBars = DAILY_PARAMS.lookback + DAILY_PARAMS.turnBars + 1;
const backtests: AssetBacktest[] = [];
for (const row of board) {
  const bars = barsBySymbol.get(row.symbol.toLowerCase()) ?? [];
  if (bars.length < minBars) continue;
  backtests.push({
    ...runBacktest(bars, DAILY_PARAMS, 10_000),
    symbol: row.symbol.toUpperCase(),
    diagnostics: signalDiagnostics(bars, DAILY_PARAMS),
  });
}

const overall: ResearchData['source'] = sources.has('sample')
  ? sources.has('live') || sources.has('cache')
    ? 'mixed'
    : 'sample'
  : 'live';
const data: ResearchData = {
  generated_at: new Date().toISOString(),
  source: overall,
  source_note:
    overall === 'sample'
      ? 'Built from the bundled SAMPLE snapshot (synthetic values, documented shapes) because no SoSoValue API key is configured. Set SOSO_API_KEY and rebuild for live data.'
      : overall === 'mixed'
        ? 'Some payloads came from the live API or its cache and some from the bundled sample snapshot (a live request failed or had no sample-free path). Treat figures with care.'
        : 'Built from the SoSoValue OpenAPI (live responses or their disk cache).',
  model: MODEL,
  model_version: MODEL_VERSION,
  market,
  rows: board,
  etf,
  indices: indexData,
  backtests,
};

// ------------------------------------------------------------ write
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board }, null, 1)}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(data));
const pageFiles = copyFlat(join(here, 'dashboard'), join(outDir, 'dashboard'));
if (!pageFiles.includes('index.html')) fail('dashboard/ holds no index.html');

const mcap = market ? num(market.total_market_cap) : null;
const btSummary = backtests
  .map((b) => `${b.symbol} ${b.roundTrips}rt/${(b.totalReturn * 100).toFixed(2)}%`)
  .join(', ');
process.stdout.write(
  `research desk: ${tracked.length} assets tracked, ${board.length} ranked, ` +
    `${indexData.length} indices, ${backtests.length} backtests (${btSummary || 'none — not enough bars'})\n` +
    `research desk: data source = ${overall}${mcap !== null ? `, total market cap $${(mcap / 1e12).toFixed(2)}T` : ''}\n` +
    `research desk: wrote board.json, data.js and dashboard/ (${pageFiles.length} files) in ${outDir}\n`,
);
