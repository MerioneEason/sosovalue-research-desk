// Dip-bounce strategy core, extracted from the author's earlier cbBTC
// race bot (its Bot.decide()) and freed of its wire protocol:
// no stdin/stdout, no harness account messages, no order objects. What is
// left is the strategy itself as a pure function of a bar series, plus a
// backtest driver that replays a series through it and reports what would
// have happened.
//
// The rule, unchanged in shape from the race bot:
//
// - Entry (flat only): the close is at least `dip` below the close
//   `lookback` bars earlier (a sharp sell-off) AND the last `turnBars`
//   bars have turned up by more than `turnUp` (the bounce has started; we
//   are not catching a falling knife). Buy with `stakeFraction` of the
//   cash on hand; the rest stays as a buffer.
// - Exit (latched in the race bot, immediate here because a backtest fill
//   cannot fail): take profit at +`takeProfit` over the position's cost,
//   stop loss at `stopLoss`, or a time stop after `maxHold` bars held,
//   whichever comes first.
// - After an exit, sit out `cooldown` bars: the entry conditions can
//   still read true at the top of the same bounce, and re-buying there
//   pays the round-trip costs again for the worst part of the move.
//
// One honest adaptation. The race ran on 1-minute bars; the SoSoValue API
// serves daily (`1d`) klines only, over the most recent 3 months. The
// parameter *shape* is the race bot's, but the daily preset below rescales
// horizons and thresholds to daily moves (a 1.8% one-hour drop and a 1.8%
// twenty-day drop are different animals). Both presets are exported so the
// change is visible, not hidden. Fees: the race harness charged roughly
// 0.3-0.4% per round trip in fees, slippage and impact; the backtest
// charges `feeBpsPerSide` per side and no slippage, stated in its output.
//
// Determinism: a pure function of the bars and the parameters. No clock,
// no randomness, no environment, no files.

/** One OHLCV bar. `t` is a millisecond epoch timestamp. */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface StrategyParams {
  /** Bars over which the sell-off is measured. */
  lookback: number;
  /** Entry needs the lookback return at or below this (e.g. -0.08). */
  dip: number;
  /** Bars over which the bounce turn is measured. */
  turnBars: number;
  /** Entry needs the turn return above this (e.g. 0.002). */
  turnUp: number;
  /** Exit when the position is worth this over cost (e.g. 0.10). */
  takeProfit: number;
  /** Exit when the position is worth this under cost (e.g. -0.05). */
  stopLoss: number;
  /** Exit after this many bars in the position. */
  maxHold: number;
  /** Bars to stay flat after an exit before re-entering. */
  cooldown: number;
  /** Buy with this fraction of the cash on hand. */
  stakeFraction: number;
  /** Fee charged on each side of a trade, in basis points. */
  feeBpsPerSide: number;
  /** Refuse entries whose notional is below this, in quote currency. */
  minNotional: number;
}

/** The race bot's original parameters, for 1-minute bars. Provenance only. */
export const RACE_PARAMS_1M: StrategyParams = {
  lookback: 60,
  dip: -0.018,
  turnBars: 5,
  turnUp: 0.0005,
  takeProfit: 0.03,
  stopLoss: -0.02,
  maxHold: 240,
  cooldown: 30,
  stakeFraction: 0.7,
  feeBpsPerSide: 15,
  minNotional: 10,
};

/**
 * The daily preset used by this project: same rule, horizons and
 * thresholds rescaled for daily bars and a ~90-bar history window.
 */
export const DAILY_PARAMS: StrategyParams = {
  lookback: 20,
  dip: -0.08,
  turnBars: 3,
  turnUp: 0.002,
  takeProfit: 0.1,
  stopLoss: -0.05,
  maxHold: 20,
  cooldown: 5,
  stakeFraction: 0.7,
  feeBpsPerSide: 15,
  minNotional: 10,
};

export type ExitReason = 'take-profit' | 'stop-loss' | 'time-stop' | 'end-of-data';

export interface Trade {
  side: 'buy' | 'sell';
  /** Index of the bar whose close filled the trade. */
  index: number;
  t: number;
  price: number;
  qty: number;
  /** Quote value of the trade before fees. */
  notional: number;
  fee: number;
  reason: 'dip-bounce entry' | ExitReason;
  /** For sells: realised return of the round trip, after fees. */
  gainPct: number | null;
}

export interface BacktestResult {
  params: StrategyParams;
  initialCash: number;
  finalEquity: number;
  /** Strategy return over the series, after fees. */
  totalReturn: number;
  /** Buying at the first close and holding to the last, no fees. */
  buyHoldReturn: number;
  /** Worst peak-to-trough fall of the equity curve, as a fraction. */
  maxDrawdown: number;
  trades: Trade[];
  /** Completed round trips. */
  roundTrips: number;
  /** Fraction of round trips that made money, 0..1; null when none closed. */
  winRate: number | null;
  /** Fraction of bars spent holding a position, 0..1. */
  exposure: number;
  /** Equity after each bar, same length as the input series. */
  equityCurve: number[];
  /** Close of each bar, echoed so the dashboard can chart both lines. */
  closes: number[];
}

/**
 * The entry test, stated once: at bar `i` (the last bar of `closes`), has
 * the market fallen hard over the lookback and just turned up? This is
 * Bot.decide()'s flat branch with the harness removed.
 */
export function entrySignal(closes: number[], i: number, p: StrategyParams): boolean {
  if (i < p.lookback || i < p.turnBars) return false;
  const last = closes[i]!;
  const lookbackReturn = last / closes[i - p.lookback]! - 1;
  if (lookbackReturn > p.dip) return false;
  const turnReturn = last / closes[i - p.turnBars]! - 1;
  return turnReturn > p.turnUp;
}

/** The two entry ingredients at bar `i`, or null when history is too short. */
export function entryParts(
  closes: number[],
  i: number,
  p: StrategyParams,
): { lookbackReturn: number; turnReturn: number } | null {
  if (i < p.lookback || i < p.turnBars) return null;
  const last = closes[i]!;
  return {
    lookbackReturn: last / closes[i - p.lookback]! - 1,
    turnReturn: last / closes[i - p.turnBars]! - 1,
  };
}

/** One notable bar of a signal scan: what the entry ingredients read there. */
export interface SignalProbe {
  index: number;
  t: number;
  /** Return over the lookback window at that bar (the "dip"). */
  lookbackReturn: number;
  /** Return over the turn window at that same bar (the "bounce"). */
  turnReturn: number;
}

/**
 * What the entry predicate did over a whole series, independent of the
 * backtest's position/cooldown state. This exists for honest reporting:
 * in a one-way drawdown the correct strategy output is "no trades", and
 * a dashboard that only shows an empty trade table cannot distinguish
 * "engine ran and stood aside" from "engine is broken". The diagnostics
 * can: they count the bars where the raw predicate fired, and when it
 * never fired they name the bars that came closest — the deepest dip
 * seen, and the bar minimising the larger of the two unmet margins
 * (dip shortfall vs turn shortfall, both in return units).
 */
export interface SignalDiagnostics {
  /** Bars with enough history to evaluate the entry predicate. */
  evaluatedBars: number;
  /** Bars where the raw entry predicate was true. */
  predicateHits: number;
  /** Bar with the deepest lookback return, and the turn read at that bar. */
  deepestDip: SignalProbe | null;
  /** Non-triggering bar closest to satisfying both entry conditions. */
  closestMiss: (SignalProbe & { shortfall: number }) | null;
}

export function signalDiagnostics(bars: Bar[], p: StrategyParams): SignalDiagnostics {
  const closes = bars.map((b) => b.c);
  let evaluatedBars = 0;
  let predicateHits = 0;
  let deepest: SignalProbe | null = null;
  let closest: (SignalProbe & { shortfall: number }) | null = null;
  for (let i = 0; i < closes.length; i++) {
    const parts = entryParts(closes, i, p);
    if (parts === null) continue;
    evaluatedBars += 1;
    const probe: SignalProbe = {
      index: i,
      t: bars[i]!.t,
      lookbackReturn: parts.lookbackReturn,
      turnReturn: parts.turnReturn,
    };
    if (deepest === null || parts.lookbackReturn < deepest.lookbackReturn) deepest = probe;
    if (entrySignal(closes, i, p)) {
      predicateHits += 1;
    } else {
      const shortfall = Math.max(parts.lookbackReturn - p.dip, p.turnUp - parts.turnReturn);
      if (closest === null || shortfall < closest.shortfall) closest = { ...probe, shortfall };
    }
  }
  return { evaluatedBars, predicateHits, deepestDip: deepest, closestMiss: closest };
}

/** Why a held position exits at bar `i`, or null to keep holding. */
export function exitReason(
  gain: number,
  barsHeld: number,
  p: StrategyParams,
): ExitReason | null {
  if (gain >= p.takeProfit) return 'take-profit';
  if (gain <= p.stopLoss) return 'stop-loss';
  if (barsHeld >= p.maxHold) return 'time-stop';
  return null;
}

/**
 * Replay `bars` through the strategy, starting flat with `initialCash`.
 * Decisions are made on each bar's close and filled at that same close —
 * the backtest analogue of the race bot deciding on the batch it had just
 * been sent. A position still open at the end is marked to market in the
 * equity curve and, if `closeAtEnd` is set, closed on the last bar with
 * reason 'end-of-data' so round-trip statistics stay honest.
 */
export function runBacktest(
  bars: Bar[],
  params: StrategyParams = DAILY_PARAMS,
  initialCash = 10_000,
  closeAtEnd = true,
): BacktestResult {
  const p = params;
  const closes = bars.map((b) => b.c);
  const feeRate = p.feeBpsPerSide / 10_000;

  let cash = initialCash;
  let qty = 0;
  let cost = 0; // total cost of the held position, fees included
  let entryIndex = -1;
  let barsHeld = 0;
  let cooldownLeft = 0;
  let barsHolding = 0;

  const trades: Trade[] = [];
  const equityCurve: number[] = new Array(bars.length).fill(initialCash);
  let roundTrips = 0;
  let wins = 0;

  const sellAll = (i: number, reason: ExitReason): void => {
    const price = closes[i]!;
    const notional = qty * price;
    const fee = notional * feeRate;
    const gainPct = cost > 0 ? (notional - fee) / cost - 1 : 0;
    trades.push({
      side: 'sell', index: i, t: bars[i]!.t, price, qty, notional, fee,
      reason, gainPct,
    });
    cash += notional - fee;
    qty = 0;
    cost = 0;
    barsHeld = 0;
    entryIndex = -1;
    cooldownLeft = p.cooldown;
    roundTrips += 1;
    if (gainPct > 0) wins += 1;
  };

  for (let i = 0; i < bars.length; i++) {
    if (qty > 0) {
      barsHeld += 1;
      barsHolding += 1;
      const value = qty * closes[i]!;
      const gain = cost > 0 ? value / cost - 1 : 0;
      const reason = exitReason(gain, barsHeld, p);
      if (reason !== null) sellAll(i, reason);
    } else if (cooldownLeft > 0) {
      cooldownLeft -= 1;
    } else if (entrySignal(closes, i, p)) {
      const notional = cash * p.stakeFraction;
      if (notional >= p.minNotional) {
        const price = closes[i]!;
        const fee = notional * feeRate;
        // The fee comes out of the same cash, so the stake shrinks by it:
        // total cash spent is exactly `notional`.
        const spent = notional;
        qty = (notional - fee) / price;
        cost = spent;
        cash -= spent;
        entryIndex = i;
        barsHeld = 0;
        trades.push({
          side: 'buy', index: i, t: bars[i]!.t, price, qty, notional: notional - fee, fee,
          reason: 'dip-bounce entry', gainPct: null,
        });
      }
    }
    equityCurve[i] = cash + qty * closes[i]!;
  }

  if (qty > 0 && closeAtEnd && bars.length > 0) {
    sellAll(bars.length - 1, 'end-of-data');
    equityCurve[bars.length - 1] = cash;
  }

  const finalEquity = bars.length > 0 ? equityCurve[bars.length - 1]! : initialCash;
  let peak = initialCash;
  let maxDrawdown = 0;
  for (const e of equityCurve) {
    if (e > peak) peak = e;
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - e) / peak);
  }
  const buyHoldReturn =
    bars.length >= 2 && closes[0]! > 0 ? closes[closes.length - 1]! / closes[0]! - 1 : 0;

  return {
    params: p,
    initialCash,
    finalEquity,
    totalReturn: initialCash > 0 ? finalEquity / initialCash - 1 : 0,
    buyHoldReturn,
    maxDrawdown,
    trades,
    roundTrips,
    winRate: roundTrips > 0 ? wins / roundTrips : null,
    exposure: bars.length > 0 ? barsHolding / bars.length : 0,
    equityCurve,
    closes,
  };
}
