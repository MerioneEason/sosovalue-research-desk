// SoSoValue OpenAPI client, written against the official documentation
// (https://sosovalue-1.gitbook.io/sosovalue-api-doc, read 2026-11-16).
//
// Facts taken from the docs, not assumed:
// - Base URL https://openapi.sosovalue.com/openapi/v1 ; every request
//   carries the header `x-soso-api-key: <key>`.
// - Every response is wrapped: { code: 0, message: "success", data: ... }
//   (Response Format page). Endpoint pages show the *contents* of `data`.
// - Rate limit is per key: 100,000 requests/month and 20 requests/minute;
//   exceeding it returns HTTP 429 with code 42901 (Rate Limit page). This
//   client spaces live requests at least 3.05s apart to stay under
//   20/minute, and caches every live response on disk so repeat builds
//   cost no quota at all.
// - Currency klines are daily only (`interval=1d`), at most the most
//   recent 3 months, `limit` default 100 / max 500 (Klines page).
// - ETF summary history needs `symbol` (BTC, ETH, ...) and `country_code`
//   (US or HK), and covers at most the most recent 1 month.
// - /market/overview numbers arrive as strings and any field may be
//   omitted when its source is down; treat every field as optional.
//
// Live-verified 2026-11-16 (first keyed run; see BUILDLOG), where the
// real API differs from what the docs alone suggest:
// - The envelope carries a fourth field, `details: null`, beside
//   { code, message, data }. Harmless; the unwrap ignores it.
// - Kline `timestamp` and `volume` arrive as *strings* ("1787097600000",
//   "29054"), not numbers. currencyKlines() coerces every field with
//   Number() before handing bars to callers.
// - Snapshot ratio fields are *fractions*, not percents:
//   change_pct_24h -0.0188 means -1.88% (cross-checked against the
//   kline-implied daily move), down_from_ath 0.49 means 49% below the
//   ATH (a positive number), up_from_cycle_low 0.11 means +11%.
//   lib/model.ts converts them to percents for display.
// - /market/overview is the exception: its total_market_cap_change_pct
//   is percent-scale ("-1.51532725" means -1.51%), exactly as its doc
//   page says. The two conventions coexist; do not "unify" them.
// - ETF summary-history returns at most ~20 rows (one month of trading
//   days) even when limit=50 is requested, newest first.
// - Index constituents' weights are fractions summing to 1.
//
// The key comes from the SOSO_API_KEY environment variable and is never
// written to disk, to the cache, or to any output file. With no key, or
// when a live request fails, the client falls back to the bundled sample
// snapshot (data/sample.json) — a small dataset shaped exactly like the
// documented responses — and says so: every result carries its source
// ('live' | 'cache' | 'sample') and the pipeline prints it.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE_URL = 'https://openapi.sosovalue.com/openapi/v1';

export type DataSource = 'live' | 'cache' | 'sample';

export interface Sourced<T> {
  data: T;
  source: DataSource;
}

export class SosoError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = 'SosoError';
    this.code = code;
  }
}

// ------------------------------------------------------------- API shapes
// Field names and types as documented per endpoint page. BigDecimal
// fields arrive as JSON numbers or numeric strings depending on the
// endpoint, so money fields are typed `number | string` and normalised
// by callers with `num()` below.

export interface CurrencyRef {
  currency_id: string;
  symbol: string;
  name: string;
}

export interface CurrencySnapshot {
  price: number | string;
  /** Fraction, not percent: -0.0188 means -1.88% (live-verified). */
  change_pct_24h: number | string;
  turnover_24h: number | string;
  turnover_rate: number | string;
  high_24h: number | string;
  low_24h: number | string;
  marketcap: number | string;
  fdv: number | string;
  max_supply: string | null;
  total_supply: string | null;
  circulating_supply: string | null;
  ath: number | string;
  /** Epoch milliseconds, as a string ("1759708800000"). */
  ath_date: string;
  /** Fraction below the ATH, positive: 0.49 means 49% down (live-verified). */
  down_from_ath: number | string;
  cycle_low: number | string;
  /** Epoch milliseconds, as a string. */
  cycle_low_date: string;
  /** Fraction above the cycle low: 0.11 means +11% (live-verified). */
  up_from_cycle_low: number | string;
  marketcap_rank: number;
}

export interface Kline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface EtfSummaryDay {
  date: string;
  total_net_inflow: number | string;
  total_value_traded: number | string;
  total_net_assets: number | string;
  cum_net_inflow: number | string;
}

export interface IndexConstituent {
  currency_id: string;
  symbol: string;
  weight: number;
}

export interface MarketOverview {
  total_market_cap?: string;
  total_market_cap_change_pct?: string;
  total_volume_24h?: string;
  eth_gas_gwei?: string;
  btc_gas_sat_vb?: string;
  as_of: number;
}

/** A documented money field as a plain number; null when unusable. */
export function num(x: number | string | null | undefined): number | null {
  if (x === null || x === undefined || x === '') return null;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------- sample

interface SampleBundle {
  note: string;
  currencies: CurrencyRef[];
  snapshots: Record<string, CurrencySnapshot>;
  klines: Record<string, Kline[]>;
  etf_summary_history: Record<string, EtfSummaryDay[]>;
  indices: string[];
  index_constituents: Record<string, IndexConstituent[]>;
  market_overview: MarketOverview;
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

let sampleCache: SampleBundle | null = null;
function loadSample(): SampleBundle {
  if (sampleCache !== null) return sampleCache;
  const path = join(projectRoot, 'data', 'sample.json');
  if (!existsSync(path)) {
    throw new SosoError(
      'no API key configured and the sample snapshot is missing: run `node tools/make-sample.mjs` once to generate data/sample.json',
    );
  }
  sampleCache = JSON.parse(readFileSync(path, 'utf8')) as SampleBundle;
  return sampleCache;
}

// ------------------------------------------------------------- client

export interface SosoClientOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Directory for the on-disk response cache. Default <project>/.cache */
  cacheDir?: string;
  /** Cache entries younger than this are reused. Default 6 hours. */
  cacheTtlMs?: number;
  /** Force sample fallback (SOSO_OFFLINE=1 does the same). */
  offline?: boolean;
  /** Log one line per request to stderr. */
  verbose?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class SosoClient {
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly cacheDir: string;
  private readonly cacheTtlMs: number;
  private readonly offline: boolean;
  private readonly verbose: boolean;
  private lastLiveAt = 0;

  constructor(opts: SosoClientOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.SOSO_API_KEY ?? null;
    this.baseUrl = (opts.baseUrl ?? process.env.SOSO_BASE_URL ?? BASE_URL).replace(/\/$/, '');
    this.cacheDir = opts.cacheDir ?? join(projectRoot, '.cache');
    this.cacheTtlMs = opts.cacheTtlMs ?? Number(process.env.SOSO_CACHE_TTL_MS ?? 6 * 3_600_000);
    this.offline = opts.offline ?? process.env.SOSO_OFFLINE === '1';
    this.verbose = opts.verbose ?? process.env.SOSO_VERBOSE === '1';
  }

  /** Whether live requests are even possible in this configuration. */
  get livePossible(): boolean {
    return !this.offline && this.apiKey !== null && this.apiKey.length > 0;
  }

  private log(msg: string): void {
    if (this.verbose) process.stderr.write(`sosovalue: ${msg}\n`);
  }

  private cachePath(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 24);
    return join(this.cacheDir, `${hash}.json`);
  }

  private readCache<T>(key: string): T | null {
    const path = this.cachePath(key);
    if (!existsSync(path)) return null;
    try {
      const entry = JSON.parse(readFileSync(path, 'utf8')) as { fetched_at: number; payload: T };
      if (Date.now() - entry.fetched_at > this.cacheTtlMs) return null;
      return entry.payload;
    } catch {
      return null;
    }
  }

  private writeCache(key: string, payload: unknown): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(this.cachePath(key), JSON.stringify({ fetched_at: Date.now(), payload }));
    } catch {
      // A failed cache write must never fail the build.
    }
  }

  /**
   * One GET through cache → live → sample. `sample` extracts this
   * endpoint's payload from the sample bundle, or throws when the bundle
   * has nothing for it.
   */
  private async get<T>(path: string, sample: (b: SampleBundle) => T | undefined): Promise<Sourced<T>> {
    const cached = this.readCache<T>(path);
    if (cached !== null) {
      this.log(`cache hit ${path}`);
      return { data: cached, source: 'cache' };
    }
    if (this.livePossible) {
      try {
        const data = await this.liveGet<T>(path);
        this.writeCache(path, data);
        return { data, source: 'live' };
      } catch (e) {
        this.log(`live ${path} failed (${e instanceof Error ? e.message : String(e)}); falling back to sample`);
      }
    }
    const fromSample = sample(loadSample());
    if (fromSample === undefined) {
      throw new SosoError(`no live data and no sample data for ${path}`);
    }
    return { data: fromSample, source: 'sample' };
  }

  private async liveGet<T>(path: string): Promise<T> {
    // Stay under the documented 20 requests/minute per key.
    const wait = this.lastLiveAt + 3_050 - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastLiveAt = Date.now();
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'x-soso-api-key': this.apiKey!, accept: 'application/json' },
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new SosoError(`HTTP ${res.status} with a non-JSON body for ${path}`);
    }
    // Unwrap the documented { code, message, data } envelope; tolerate a
    // bare payload in case an endpoint skips the envelope.
    if (typeof body === 'object' && body !== null && 'code' in body) {
      const env = body as { code: number; message?: string; data: T };
      if (env.code !== 0) {
        throw new SosoError(`API error ${env.code} for ${path}: ${env.message ?? 'unknown'}`, env.code);
      }
      return env.data;
    }
    if (!res.ok) throw new SosoError(`HTTP ${res.status} for ${path}`);
    return body as T;
  }

  // ---------------------------------------------------------- endpoints

  /** GET /currencies — every listed currency (docs 1.1). */
  listCurrencies(): Promise<Sourced<CurrencyRef[]>> {
    return this.get('/currencies', (b) => b.currencies);
  }

  /** GET /currencies/{id}/market-snapshot (docs 1.3). */
  currencySnapshot(currencyId: string): Promise<Sourced<CurrencySnapshot>> {
    return this.get(
      `/currencies/${encodeURIComponent(currencyId)}/market-snapshot`,
      (b) => b.snapshots[currencyId],
    );
  }

  /**
   * GET /currencies/{id}/klines (docs 1.5). Daily bars only; the docs
   * cap the range at the most recent 3 months and `limit` at 500.
   * Live bars arrive with `timestamp` and `volume` as strings, so every
   * field is coerced to a number here; the sample payload already uses
   * numbers and passes through unchanged.
   */
  async currencyKlines(
    currencyId: string,
    limit = 90,
  ): Promise<Sourced<Kline[]>> {
    const q = new URLSearchParams({ interval: '1d', limit: String(limit) });
    const r = await this.get<Kline[]>(`/currencies/${encodeURIComponent(currencyId)}/klines?${q}`, (b) =>
      (b.klines[currencyId] ?? []).slice(-limit),
    );
    return {
      data: r.data.map((k) => ({
        timestamp: Number(k.timestamp),
        open: Number(k.open),
        high: Number(k.high),
        low: Number(k.low),
        close: Number(k.close),
        volume: Number(k.volume),
      })),
      source: r.source,
    };
  }

  /**
   * GET /etfs/summary-history (docs 2.1). `symbol` is the tracked asset
   * (BTC, ETH, SOL, ...), `countryCode` is US or HK. Most recent 1 month.
   */
  etfSummaryHistory(
    symbol: string,
    countryCode: 'US' | 'HK' = 'US',
    limit = 50,
  ): Promise<Sourced<EtfSummaryDay[]>> {
    const q = new URLSearchParams({
      symbol: symbol.toUpperCase(),
      country_code: countryCode,
      limit: String(limit),
    });
    return this.get(`/etfs/summary-history?${q}`, (b) =>
      b.etf_summary_history[`${symbol.toUpperCase()}:${countryCode}`],
    );
  }

  /** GET /indices — a bare array of index tickers (docs 3.1). */
  listIndices(): Promise<Sourced<string[]>> {
    return this.get('/indices', (b) => b.indices);
  }

  /** GET /indices/{ticker}/constituents (docs 3.2). */
  indexConstituents(ticker: string): Promise<Sourced<IndexConstituent[]>> {
    return this.get(
      `/indices/${encodeURIComponent(ticker)}/constituents`,
      (b) => b.index_constituents[ticker],
    );
  }

  /**
   * GET /indices/{ticker}/market-snapshot (docs 3.3). Live-verified
   * 2026-11-16: returns price, change_pct_24h and roi_7d/1m/3m/1y + ytd,
   * all as fractions. The pipeline deliberately does not call it — the
   * indices view is constituents-only — but the method stays for parity
   * with the docs. It has no sample payload and throws offline.
   */
  indexSnapshot(ticker: string): Promise<Sourced<Record<string, unknown>>> {
    return this.get(
      `/indices/${encodeURIComponent(ticker)}/market-snapshot`,
      () => undefined,
    );
  }

  /** GET /market/overview (docs 10.1). Every field is optional. */
  marketOverview(): Promise<Sourced<MarketOverview>> {
    return this.get('/market/overview', (b) => b.market_overview);
  }
}
