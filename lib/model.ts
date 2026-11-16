// Research board model: SoSoValue API payloads in, one ranked board out.
//
// Adapted from the author's earlier Launch Radar model skeleton: the
// same discipline — typed inputs, one constants block
// printed verbatim in the dashboard, pure scoring functions, a board
// builder, and a data.js writer — pointed at a different question. The
// radar asked "what could a token launch be worth"; this board asks
// "which large crypto assets deserve a researcher's attention today".
//
// The score, in one paragraph. Every input comes from a documented
// SoSoValue field; no asset is special-cased. Momentum blends the 30-day
// and 7-day kline returns (clamped, so one wild month cannot carry the
// board). Position measures where the price sits between its cycle low
// and its all-time high, both from the market snapshot. Liquidity is the
// snapshot's own turnover rate, capped. The weighted sum lands on 0-100:
//
//   momentum   = clamp(0.6 x ret30 + 0.4 x ret7, -60, +60) / 60   (-1..1)
//   position   = (price - cycle_low) / (ath - cycle_low)          ( 0..1)
//   liquidity  = clamp(turnover_rate, 0, 0.5) / 0.5               ( 0..1)
//   score      = clamp(45 + 30 x momentum + 15 x (2 x position - 1)
//                      + 10 x liquidity, 0, 100)
//
// The scale is ABSOLUTE, not relative: the inputs are each asset's own
// returns and position, never normalised against the other rows, and the
// stance bands (65/50/35) are fixed. So in a market-wide drawdown the
// whole board can read "weak" at once — on the 2026-11-16 live build all
// ten assets did, with 30-day returns of -21% to -35%. That is the model
// reporting the market, not a malfunction: the rank still orders the
// assets by the same arithmetic, but no asset is promoted merely for
// falling less than its peers. The dashboard states this beside the
// board so the board is not misread.
//
// The dashboard restates this arithmetic and recomputes every row in the
// page, so a reader can check the board against the code that states it —
// the same self-check the radar shipped with.

import type {
  CurrencyRef,
  CurrencySnapshot,
  EtfSummaryDay,
  IndexConstituent,
  Kline,
  MarketOverview,
} from './sosovalue.ts';
import { num } from './sosovalue.ts';
import type { BacktestResult, SignalDiagnostics } from './strategy.ts';

/** One asset's backtest plus the signal scan that explains its trades (or their absence). */
export interface AssetBacktest extends BacktestResult {
  /** Display symbol, e.g. "BTC". */
  symbol: string;
  diagnostics: SignalDiagnostics;
}

export const MODEL_VERSION = 'soso-research-1';

/** The model's constants, printed in the dashboard so the arithmetic is checkable. */
export interface ResearchModel {
  momentum_w30: number;
  momentum_w7: number;
  momentum_clamp_pct: number;
  base: number;
  momentum_weight: number;
  position_weight: number;
  liquidity_weight: number;
  liquidity_cap_rate: number;
}

export const MODEL: ResearchModel = {
  momentum_w30: 0.6,
  momentum_w7: 0.4,
  momentum_clamp_pct: 60,
  base: 45,
  momentum_weight: 30,
  position_weight: 15,
  liquidity_weight: 10,
  liquidity_cap_rate: 0.5,
};

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Everything the pipeline assembled for one asset. */
export interface AssetInput {
  ref: CurrencyRef;
  snapshot: CurrencySnapshot | null;
  klines: Kline[];
  /** Index tickers this asset belongs to, with its weight in each. */
  memberships: { ticker: string; weight: number }[];
}

export type Stance = 'strong' | 'constructive' | 'neutral' | 'weak';

export interface ScoreParts {
  momentum: number;
  position: number;
  liquidity: number;
  score: number;
}

/** The three score inputs and the score itself; restated in the dashboard. */
export function scoreOf(
  ret30Pct: number | null,
  ret7Pct: number | null,
  position: number | null,
  turnoverRate: number | null,
  model: ResearchModel = MODEL,
): ScoreParts {
  const blended =
    (ret30Pct ?? 0) * model.momentum_w30 + (ret7Pct ?? 0) * model.momentum_w7;
  const momentum = round4(
    clamp(blended, -model.momentum_clamp_pct, model.momentum_clamp_pct) / model.momentum_clamp_pct,
  );
  const pos = round4(clamp(position ?? 0.5, 0, 1));
  const liquidity = round4(
    clamp((turnoverRate ?? 0) / model.liquidity_cap_rate, 0, 1),
  );
  const score = Math.round(
    clamp(
      model.base +
        model.momentum_weight * momentum +
        model.position_weight * (2 * pos - 1) +
        model.liquidity_weight * liquidity,
      0,
      100,
    ),
  );
  return { momentum, position: pos, liquidity, score };
}

export function stanceOf(score: number): Stance {
  if (score >= 65) return 'strong';
  if (score >= 50) return 'constructive';
  if (score >= 35) return 'neutral';
  return 'weak';
}

/** Data depth decides how much of the score is measured, not defaulted. */
export function confidenceOf(klineCount: number, hasSnapshot: boolean): 'high' | 'medium' | 'low' {
  if (hasSnapshot && klineCount >= 60) return 'high';
  if (hasSnapshot && klineCount >= 30) return 'medium';
  return 'low';
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  currency_id: string;
  symbol: string;
  name: string;
  price: number | null;
  change_24h_pct: number | null;
  ret_7d_pct: number | null;
  ret_30d_pct: number | null;
  volatility_30d_pct: number | null;
  marketcap: number | null;
  fdv: number | null;
  turnover_24h: number | null;
  turnover_rate: number | null;
  down_from_ath_pct: number | null;
  indices: { ticker: string; weight: number }[];
  score: ScoreParts;
  stance: Stance;
  confidence: 'high' | 'medium' | 'low';
  /** Last 30 daily closes, for the row's sparkline. */
  closes_30d: number[];
}

/** Kline-derived statistics for one asset; nulls when history is short. */
export function klineStats(klines: Kline[]): {
  ret7: number | null;
  ret30: number | null;
  vol30: number | null;
} {
  const closes = klines.map((k) => k.close);
  const ret = (back: number): number | null => {
    if (closes.length <= back) return null;
    const then = closes[closes.length - 1 - back]!;
    const now = closes[closes.length - 1]!;
    return then > 0 ? round2((now / then - 1) * 100) : null;
  };
  let vol30: number | null = null;
  if (closes.length >= 10) {
    const window = closes.slice(-31);
    const rets: number[] = [];
    for (let i = 1; i < window.length; i++) {
      if (window[i - 1]! > 0) rets.push(Math.log(window[i]! / window[i - 1]!));
    }
    if (rets.length >= 9) {
      const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
      const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
      vol30 = round2(Math.sqrt(variance) * 100);
    }
  }
  return { ret7: ret(7), ret30: ret(30), vol30 };
}

/** Score every assembled asset and rank by score, market cap breaking ties. */
export function buildBoard(inputs: AssetInput[], model: ResearchModel = MODEL): BoardRow[] {
  const rows = inputs.map((a) => {
    const snap = a.snapshot;
    const stats = klineStats(a.klines);
    const price = snap ? num(snap.price) : (a.klines[a.klines.length - 1]?.close ?? null);
    const ath = snap ? num(snap.ath) : null;
    const cycleLow = snap ? num(snap.cycle_low) : null;
    const position =
      price !== null && ath !== null && cycleLow !== null && ath > cycleLow
        ? (price - cycleLow) / (ath - cycleLow)
        : null;
    const turnoverRate = snap ? num(snap.turnover_rate) : null;
    const score = scoreOf(stats.ret30, stats.ret7, position, turnoverRate, model);
    // Unit conventions, live-verified 2026-11-16: the snapshot's
    // change_pct_24h and down_from_ath are *fractions* (-0.0188 is
    // -1.88%; 0.49 is 49% below the ATH), while the board's *_pct
    // fields are percents — convert here. (/market/overview's change
    // field is the opposite convention, percent-scale, and passes
    // through to the dashboard untouched.)
    const changeFrac = snap ? num(snap.change_pct_24h) : null;
    const downFrac = snap ? num(snap.down_from_ath) : null;
    const downFromAth = downFrac === null ? null : round2(downFrac * 100);
    return {
      rank: 0,
      currency_id: a.ref.currency_id,
      symbol: a.ref.symbol,
      name: a.ref.name,
      price,
      change_24h_pct: changeFrac === null ? null : round2(changeFrac * 100),
      ret_7d_pct: stats.ret7,
      ret_30d_pct: stats.ret30,
      volatility_30d_pct: stats.vol30,
      marketcap: snap ? num(snap.marketcap) : null,
      fdv: snap ? num(snap.fdv) : null,
      turnover_24h: snap ? num(snap.turnover_24h) : null,
      turnover_rate: turnoverRate,
      down_from_ath_pct: downFromAth,
      indices: a.memberships,
      score,
      stance: stanceOf(score.score),
      confidence: confidenceOf(a.klines.length, snap !== null),
      closes_30d: a.klines.slice(-30).map((k) => k.close),
    } satisfies BoardRow;
  });
  rows.sort(
    (x, y) =>
      y.score.score - x.score.score ||
      (y.marketcap ?? 0) - (x.marketcap ?? 0) ||
      (x.symbol < y.symbol ? -1 : 1),
  );
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  return rows;
}

/** Everything data.js carries for the page. */
export interface ResearchData {
  generated_at: string;
  /** 'live' when every payload came from the API or its cache, else 'sample' or 'mixed'. */
  source: 'live' | 'sample' | 'mixed';
  source_note: string;
  model: ResearchModel;
  model_version: string;
  market: MarketOverview | null;
  rows: BoardRow[];
  etf: Record<string, EtfSummaryDay[]>;
  indices: { ticker: string; constituents: IndexConstituent[] }[];
  /** One backtest per tracked asset, in board-rank order. */
  backtests: AssetBacktest[];
}

/** data.js: the dashboard's whole dataset as one classic script, no fetch and no network. */
export function dataScript(data: ResearchData): string {
  return `window.SOSO=${JSON.stringify(data)};\n`;
}
