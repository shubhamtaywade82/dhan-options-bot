/**
 * Option-chain analytics: PCR, OI shifts around ATM, IV and greeks extraction.
 * Pure functions over the normalized chain shape produced by MarketData.optionChain().
 */

/**
 * @param {object} chain  { spot, expiry, strikes: [{strike, ce, pe}] }
 * @param {object} [opts] { atmWindow }
 */
export function computeChainMetrics(chain, { atmWindow = 2 } = {}) {
  const spot = chain.spot;
  const strikes = chain.strikes;
  if (!Number.isFinite(spot) || strikes.length === 0) {
    throw new Error('chain is empty or has no spot');
  }

  // ATM = strike nearest to spot.
  const atm = strikes.reduce((best, s) =>
    Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best, strikes[0]);

  // Aggregate OI across the whole chain (liquidity guard: skip empty strikes).
  let totalCeOi = 0, totalPeOi = 0, totalCeOiChg = 0, totalPeOiChg = 0;
  let atmCeIv = null, atmPeIv = null;
  for (const s of strikes) {
    if (s.ce && s.ce.oi) {
      totalCeOi += s.ce.oi;
      totalCeOiChg += (s.ce.oi || 0) - (s.ce.previous_oi || 0);
    }
    if (s.pe && s.pe.oi) {
      totalPeOi += s.pe.oi;
      totalPeOiChg += (s.pe.oi || 0) - (s.pe.previous_oi || 0);
    }
  }

  // OI change in the ATM +/- atmWindow strikes = today's positioning battle.
  const idx = strikes.indexOf(atm);
  let nearCeOi = 0, nearCeOiChg = 0, nearPeOi = 0, nearPeOiChg = 0;
  for (let i = Math.max(0, idx - atmWindow); i <= Math.min(strikes.length - 1, idx + atmWindow); i++) {
    const s = strikes[i];
    if (s.ce) { nearCeOi += s.ce.oi || 0; nearCeOiChg += (s.ce.oi || 0) - (s.ce.previous_oi || 0); }
    if (s.pe) { nearPeOi += s.pe.oi || 0; nearPeOiChg += (s.pe.oi || 0) - (s.pe.previous_oi || 0); }
  }

  const ceLeg = atm.ce, peLeg = atm.pe;
  if (ceLeg?.implied_volatility != null) atmCeIv = ceLeg.implied_volatility;
  if (peLeg?.implied_volatility != null) atmPeIv = peLeg.implied_volatility;
  const atmIv = atmCeIv != null && atmPeIv != null ? (atmCeIv + atmPeIv) / 2 : (atmCeIv ?? atmPeIv ?? null);

  return {
    spot,
    expiry: chain.expiry,
    atmStrike: atm.strike,
    atmLegs: { ce: ceLeg || null, pe: peLeg || null },
    pcr: totalCeOi > 0 ? totalPeOi / totalCeOi : null,
    totalCeOi, totalPeOi,
    totalCeOiChg, totalPeOiChg,
    nearCeOi, nearPeOi, nearCeOiChg, nearPeOiChg,
    atmIv,
    strikeCount: strikes.length,
  };
}

/**
 * PCR sentiment score in [-1, +1].
 * High PCR (more puts written / calls unwound) is classically bullish support;
 * low PCR is bearish. Saturates once PCR is 50% beyond the thresholds.
 */
export function pcrScore(pcr, { bullish = 1.1, bearish = 0.8 } = {}) {
  if (pcr == null || !Number.isFinite(pcr)) return 0;
  if (pcr >= bullish) {
    return Math.min(1, 0.6 + 0.4 * ((pcr - bullish) / (0.5 * bullish)));
  }
  if (pcr <= bearish) {
    return Math.max(-1, -0.6 - 0.4 * ((bearish - pcr) / (0.5 * bearish)));
  }
  // Between thresholds: linear from -0.6..+0.6 through 0 at midpoint.
  const mid = (bullish + bearish) / 2;
  return 0.6 * (pcr - mid) / (bullish - mid);
}

/**
 * OI-shift score in [-1, +1] from today's OI change near ATM.
 *  - PE OI rising   = put writing = support building  -> bullish (+)
 *  - CE OI rising   = call writing = resistance       -> bearish (-)
 *  - Unwinding (negative change) flips the sign.
 * Normalized by the standing OI so huge indexes and small stocks score alike.
 */
export function oiShiftScore({ nearCeOiChg = 0, nearPeOiChg = 0, nearCeOi = 1, nearPeOi = 1 } = {}) {
  const ceNorm = nearCeOi > 0 ? nearCeOiChg / nearCeOi : 0;
  const peNorm = nearPeOi > 0 ? nearPeOiChg / nearPeOi : 0;
  const bullish = clamp(peNorm, -1, 1);   // put writing positive
  const bearish = clamp(ceNorm, -1, 1);   // call writing positive
  // bullish contribution (+), bearish contribution (-); average then damp to [-1,1]
  const raw = (bullish - bearish) / 2;
  return clamp(raw * 1.5, -1, 1);
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Composite chain bias in [-1, +1]: average of PCR sentiment and OI shift.
 * +1 = strongly bullish positioning (put writing, calls unwinding).
 * Attached to chain metrics by the scan loop and consumed by the strategy
 * registry's confirmation gate and the Tev1 market state.
 */
export function computeChainBias(metrics, { bullish = 1.1, bearish = 0.8 } = {}) {
  const p = pcrScore(metrics?.pcr, { bullish, bearish });
  const o = oiShiftScore(metrics || {});
  return clamp((p + o) / 2, -1, 1);
}
