/**
 * Strategy Registry (deterministic Layer 1).
 *
 * Five versioned strategy families. Each returns at most one candidate per
 * evaluation; candidates carry direction (CE/PE), a normalized score in [0,1]
 * and deterministic evidence. Eligibility (regime, params, chain confirmation)
 * is enforced HERE, before any model ever sees the candidates - the Tev1
 * selector can only choose among what this registry emits, plus NO_TRADE.
 *
 * Families (aligned with the reference architecture):
 *   ema_cross          EMA fast/slow cross with slope confirmation
 *   trend_continuation Pullback-resume inside an established trend
 *   range_break        Opening-range breakout (first N candles)
 *   momentum_break     Short-burst momentum + volume surge
 *   trend_flip         Exhaustion reversal at RSI extremes (needs chain support)
 */

import { ema, emaTrendScore } from '../strategy/indicators.js';
import { REGIMES } from '../context/marketContext.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export class StrategyRegistry {
  /**
   * @param {object} cfg  {
   *   strategies: { emaCross:{enabled,minSpreadPct}, trendContinuation:{enabled},
   *                 rangeBreak:{enabled,rangeCandles,volumeSurge},
   *                 momentumBreak:{enabled,rocPct,volumeSurge},
   *                 trendFlip:{enabled,rsiOverbought,rsiOversold} },
   *   chainConfirmation: { enabled, opposeKill, agreeBoost },
   * }
   */
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.definitions = [
      {
        strategyId: 'ema_cross', configKey: 'emaCross', version: '1.0',
        description: 'EMA 9/21 cross with slope confirmation; trades in the direction of the fresh cross.',
        regimes: [REGIMES.TREND_UP, REGIMES.TREND_DOWN, REGIMES.TRANSITION],
        evaluate: (ctx) => this._emaCross(ctx),
      },
      {
        strategyId: 'trend_continuation', configKey: 'trendContinuation', version: '1.0',
        description: 'Pullback inside an established trend that resumes in the trend direction.',
        regimes: [REGIMES.TREND_UP, REGIMES.TREND_DOWN],
        evaluate: (ctx) => this._trendContinuation(ctx),
      },
      {
        strategyId: 'range_break', configKey: 'rangeBreak', version: '1.0',
        description: 'Breakout beyond the opening range high/low with volume confirmation.',
        regimes: [REGIMES.RANGE, REGIMES.TRANSITION],
        evaluate: (ctx) => this._rangeBreak(ctx),
      },
      {
        strategyId: 'momentum_break', configKey: 'momentumBreak', version: '1.0',
        description: 'Short momentum burst over three candles with a volume surge.',
        regimes: [REGIMES.TREND_UP, REGIMES.TREND_DOWN, REGIMES.TRANSITION, REGIMES.RANGE],
        evaluate: (ctx) => this._momentumBreak(ctx),
      },
      {
        strategyId: 'trend_flip', configKey: 'trendFlip', version: '1.0',
        description: 'Exhaustion reversal at RSI extremes, requiring option-chain support.',
        regimes: [REGIMES.TREND_UP, REGIMES.TREND_DOWN, REGIMES.TRANSITION],
        evaluate: (ctx) => this._trendFlip(ctx),
      },
    ];
  }

  list() {
    return this.definitions.map(({ strategyId, version, description }) => ({ strategyId, version, description }));
  }

  /** Evaluate every enabled strategy; returns candidates (may be empty). */
  evaluateAll({ candles, context, chainMetrics }) {
    const out = [];
    for (const def of this.definitions) {
      const cfg = this.cfg.strategies?.[def.configKey] ?? this.cfg.strategies?.[def.strategyId];
      if (cfg && cfg.enabled === false) continue;
      if (!context.enoughData) continue;
      if (!def.regimes.includes(context.regime)) continue;
      try {
        const candidate = def.evaluate({ candles, context, chainMetrics, cfg: cfg || {} });
        if (candidate) out.push(candidate);
      } catch { /* a broken strategy must never break the scan loop */ }
    }
    return out;
  }

  /* ------------------------------ families ------------------------------ */

  _emaCross({ candles, context, cfg }) {
    const minSpread = cfg.minSpreadPct ?? 0.05;
    const spread = context.emaSpreadPct;
    if (Math.abs(spread) < minSpread) return null;

    const closes = candles.map((c) => c.close);
    const trend = emaTrendScore(closes, { fast: 9, slow: 21 });
    const direction = spread > 0 ? 'CE' : 'PE';
    if (direction === 'CE' && trend <= 0) return null;
    if (direction === 'PE' && trend >= 0) return null;

    let score = clamp01(Math.min(1, Math.abs(spread) / 0.15) * 0.6 + Math.abs(trend) * 0.4);
    score = this._applyChain(score, direction, context);
    if (score == null) return null;
    return this._candidate('ema_cross', direction, score, {
      emaSpreadPct: round3(spread), emaTrendScore: round3(trend),
    });
  }

  _trendContinuation({ candles, context, cfg }) {
    const spread = context.emaSpreadPct;
    const direction = spread > 0 ? 'CE' : 'PE';
    if (Math.abs(spread) < 0.08) return null;

    const n = candles.length;
    // Pullback quality is measured BEFORE the resumption candle - the
    // resumption itself lifts RSI and would mask the pullback.
    const rsiNow = context.rsi14Prev ?? context.rsi14;
    const last = candles[n - 1], prev = candles[n - 2];
    const resumption = direction === 'CE' ? last.close > prev.close : last.close < prev.close;
    if (!resumption) return null;

    const pullbackOk = direction === 'CE'
      ? rsiNow >= 40 && rsiNow <= 62
      : rsiNow >= 38 && rsiNow <= 60;
    if (!pullbackOk) return null;

    const vwapMax = cfg.vwapMaxDistancePct ?? 1.0;
    if (Math.abs(context.vwapDistancePct) > vwapMax) return null; // over-extended

    const pullbackQuality = direction === 'CE'
      ? 1 - Math.abs(rsiNow - 51) / 11
      : 1 - Math.abs(rsiNow - 49) / 11;
    let score = clamp01(0.55 * context.trendStrength + 0.35 * clamp01(pullbackQuality));
    score = this._applyChain(score, direction, context);
    if (score == null) return null;
    return this._candidate('trend_continuation', direction, score, {
      rsi14: rsiNow, trendStrength: context.trendStrength, vwapDistancePct: context.vwapDistancePct,
    });
  }

  _rangeBreak({ candles, context, cfg }) {
    const rangeCandles = Math.max(1, cfg.rangeCandles ?? 3);
    const volumeSurge = cfg.volumeSurge ?? 1.2;
    if (candles.length < rangeCandles + 1) return null;

    const opening = candles.slice(0, rangeCandles);
    const rangeHigh = Math.max(...opening.map((c) => c.high));
    const rangeLow = Math.min(...opening.map((c) => c.low));
    const last = candles[candles.length - 1];
    const avgVol = opening.reduce((a, c) => a + (c.volume || 0), 0) / rangeCandles;

    let direction = null;
    if (last.close > rangeHigh) direction = 'CE';
    else if (last.close < rangeLow) direction = 'PE';
    if (!direction) return null;

    if (avgVol > 0 && last.volume < volumeSurge * avgVol) return null;

    const marginPct = context.spot > 0
      ? (direction === 'CE' ? last.close - rangeHigh : rangeLow - last.close) / context.spot * 100
      : 0;
    const volFactor = avgVol > 0 ? clamp01((last.volume / avgVol - 1) / 1.5) : 0.3;
    let score = clamp01(0.5 + 0.25 * clamp01(marginPct / 0.1) + 0.25 * volFactor);
    score = this._applyChain(score, direction, context);
    if (score == null) return null;
    return this._candidate('range_break', direction, score, {
      rangeHigh, rangeLow, breakoutMarginPct: round3(marginPct), volumeVsRangeAvg: round2(avgVol > 0 ? last.volume / avgVol : 0),
    });
  }

  _momentumBreak({ candles, context, cfg }) {
    const rocPct = cfg.rocPct ?? 0.35;
    const volumeSurge = cfg.volumeSurge ?? 1.5;
    const n = candles.length;
    if (n < 4) return null;
    const last = candles[n - 1];
    const ref = candles[n - 4].close;
    if (!(ref > 0)) return null;
    const roc = ((last.close - ref) / ref) * 100;
    if (Math.abs(roc) < rocPct) return null;

    const volWindow = candles.slice(Math.max(0, n - 11), n - 1);
    const avgVol = volWindow.reduce((a, c) => a + (c.volume || 0), 0) / Math.max(1, volWindow.length);
    if (avgVol > 0 && last.volume < volumeSurge * avgVol) return null;

    const direction = roc > 0 ? 'CE' : 'PE';
    const volFactor = avgVol > 0 ? clamp01((last.volume / avgVol - 1) / 2) : 0.3;
    let score = clamp01(Math.min(1, Math.abs(roc) / 0.8) * 0.65 + 0.35 * volFactor);
    score = this._applyChain(score, direction, context);
    if (score == null) return null;
    return this._candidate('momentum_break', direction, score, {
      roc3Pct: round3(roc), volumeVsAvg: round2(avgVol > 0 ? last.volume / avgVol : 0),
    });
  }

  _trendFlip({ candles, context, cfg }) {
    const overbought = cfg.rsiOverbought ?? 72;
    const oversold = cfg.rsiOversold ?? 28;
    const n = candles.length;
    const last = candles[n - 1], prev = candles[n - 2];
    const spread = context.emaSpreadPct;

    // PE: prior uptrend exhausted; CE: prior downtrend exhausted.
    if (spread > 0.08 && context.rsi14 >= overbought && last.close < prev.close) {
      // Flipping against an uptrend requires the chain to turn bearish (calls being written).
      const bias = context.chain?.chainBias ?? 0;
      if (bias > -0.1) return null;
      const extremity = clamp01((context.rsi14 - overbought) / (100 - overbought));
      const score = clamp01(0.45 + 0.3 * extremity + 0.25 * clamp01(-bias));
      return this._candidate('trend_flip', 'PE', score, { rsi14: context.rsi14, chainBias: round3(bias) });
    }
    if (spread < -0.08 && context.rsi14 <= oversold && last.close > prev.close) {
      // Flipping against a downtrend requires the chain to turn bullish (puts being written).
      const bias = context.chain?.chainBias ?? 0;
      if (bias < 0.1) return null;
      const extremity = clamp01((oversold - context.rsi14) / oversold);
      const score = clamp01(0.45 + 0.3 * extremity + 0.25 * clamp01(bias));
      return this._candidate('trend_flip', 'CE', score, { rsi14: context.rsi14, chainBias: round3(bias) });
    }
    return null;
  }

  /* ------------------------------ internals ------------------------------ */

  /**
   * Chain confirmation: a strongly opposing chain kills the candidate,
   * an agreeing chain boosts it. Returns adjusted score or null (killed).
   */
  _applyChain(score, direction, context) {
    const cc = this.cfg.chainConfirmation;
    if (!cc || cc.enabled === false) return score;
    const bias = context.chain?.chainBias ?? 0; // + bullish, - bearish
    const alignedBias = direction === 'CE' ? bias : -bias;
    if (alignedBias <= -(cc.opposeKill ?? 0.2)) return null;
    return clamp01(score + (cc.agreeBoost ?? 0.15) * alignedBias);
  }

  _candidate(strategyId, direction, score, evidence) {
    return {
      strategyId,
      version: this.definitions.find((d) => d.strategyId === strategyId)?.version || '1.0',
      direction,
      score: Math.round(score * 1000) / 1000,
      evidence,
    };
  }
}

const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : 0);
const round3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : 0);

export { ema };
