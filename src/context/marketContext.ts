/**
 * Market Context Engine (deterministic Layer-1 feature builder).
 *
 * Converts raw candles + option-chain metrics into a versioned market-state
 * object: regime classification, trend strength, volatility, VWAP distance and
 * support/resistance distances. Strategies and the Tev1 selector consume this
 * context; nothing here makes trading decisions by itself.
 *
 * Regimes: TREND_UP | TREND_DOWN | RANGE | HIGH_VOLATILITY | TRANSITION
 */

import { ema, rsi, atr, adx, vwap } from '../strategy/indicators.js';

export const CONTEXT_SCHEMA_VERSION = 'options-decision-v1';

export const REGIMES = {
  TREND_UP: 'TREND_UP',
  TREND_DOWN: 'TREND_DOWN',
  RANGE: 'RANGE',
  HIGH_VOLATILITY: 'HIGH_VOLATILITY',
  TRANSITION: 'TRANSITION',
};

/**
 * @param {Array} candles  5-min (or configured interval) OHLCV candles of the underlying
 * @param {object} [chainMetrics]  output of computeChainMetrics (optional)
 * @param {object} [cfg]  { adxTrend, adxRange, highVolAtrPct, minCandles, emaFast, emaSlow }
 */
export function buildMarketContext(candles: any[], chainMetrics: any = null, cfg: any = {}) {
  const adxTrend = cfg.adxTrend ?? 25;
  const adxRange = cfg.adxRange ?? 18;
  const highVolAtrPct = cfg.highVolAtrPct ?? 0.25;
  const minCandles = cfg.minCandles ?? 20;
  const emaFast = cfg.emaFast ?? 9;
  const emaSlow = cfg.emaSlow ?? 21;

  const n = candles.length;
  const last = n > 0 ? candles[n - 1] : null;
  // Regime inputs are read at the PREVIOUS candle: the triggering candle must
  // not reclassify its own context (a breakout candle would otherwise inflate
  // ATR into HIGH_VOLATILITY and veto the breakout strategy that trades it).
  const ctxIdx = Math.max(0, n - 2);
  const closes = candles.map((c) => c.close);
  const f = ema(closes, emaFast);
  const s = ema(closes, emaSlow);
  const rsiSeries = rsi(closes, 14);
  const atrSeries = atr(candles, 14);
  const { adx: adxSeries } = adx(candles, 14);
  const v = vwap(candles);

  const spot = last ? last.close : (chainMetrics?.spot ?? 0);
  const firstOpen = n > 0 ? candles[0].open : spot;
  const dayHigh = n > 0 ? Math.max(...candles.map((c) => c.high)) : spot;
  const dayLow = n > 0 ? Math.min(...candles.map((c) => c.low)) : spot;

  const atrPct = last && spot > 0 ? ((atrSeries[ctxIdx] || 0) / spot) * 100 : 0;
  const adxNow = n > 0 ? adxSeries[ctxIdx] : 0;
  const rsiNow = n > 0 ? rsiSeries[n - 1] : 50;
  const rsiPrev = n > 1 ? rsiSeries[n - 2] : rsiNow;
  const emaSpreadPct = n > 0 && s[n - 1] > 0 ? ((f[n - 1] - s[n - 1]) / s[n - 1]) * 100 : 0;

  let regime = REGIMES.TRANSITION;
  if (n >= minCandles) {
    if (atrPct >= highVolAtrPct) regime = REGIMES.HIGH_VOLATILITY;
    else if (adxNow >= adxTrend) regime = f[n - 1] > s[n - 1] ? REGIMES.TREND_UP : REGIMES.TREND_DOWN;
    else if (adxNow <= adxRange) regime = REGIMES.RANGE;
  }

  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    enoughData: n >= minCandles,
    candleCount: n,
    lastCandleTs: last ? last.ts : 0,
    regime,
    spot,
    // deterministic features
    adx: round2(adxNow),
    rsi14: round2(rsiNow),
    rsi14Prev: round2(rsiPrev),
    atrPct: round3(atrPct),
    emaSpreadPct: round3(emaSpreadPct),
    trendStrength: round3(Math.min(1, adxNow / 50)),
    vwap: round2(v),
    vwapDistancePct: v > 0 ? round3(((spot - v) / v) * 100) : 0,
    changePct: firstOpen > 0 ? round3(((spot - firstOpen) / firstOpen) * 100) : 0,
    supportDistancePct: spot > 0 ? round3(((spot - dayLow) / spot) * 100) : 0,
    resistanceDistancePct: spot > 0 ? round3(((dayHigh - spot) / spot) * 100) : 0,
    dayHigh: round2(dayHigh),
    dayLow: round2(dayLow),
    // option-chain summary (when available)
    chain: chainMetrics ? {
      atmStrike: chainMetrics.atmStrike,
      atmIv: chainMetrics.atmIv != null ? round2(chainMetrics.atmIv) : null,
      putCallOiRatio: chainMetrics.pcr != null ? round3(chainMetrics.pcr) : null,
      chainBias: chainMetrics.chainBias ?? 0,
    } : null,
  };
}

const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : 0);
const round3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : 0);
