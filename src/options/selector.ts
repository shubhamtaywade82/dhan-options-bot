/**
 * Option Selector (deterministic Layer 1, contract construction).
 *
 * Turns a directional candidate into a concrete option contract:
 *   - strike selection around ATM (configurable offset),
 *   - executable entry price = best ask (a buy fills at the ask, not the LTP),
 *   - liquidity filters: bid/ask spread, leg volume, leg OI, IV band,
 *     delta band and chain-snapshot freshness.
 *
 * Returns { ok, leg, strike, entryPrice, spreadPct, violations }.
 * `violations` is always populated so the decision journal can record exactly
 * why a candidate was filtered.
 */

export class OptionSelector {
  cfg: any;

  /**
   * @param {object} cfg {
   *   strikeOffset, maxSpreadPct, minLegVolume, minLegOi, maxChainAgeMs,
   *   minDelta, maxDelta, ivMin, ivMax
   * }
   */
  constructor(cfg: any = {}) {
    this.cfg = {
      strikeOffset: 0,
      maxSpreadPct: 3,
      minLegVolume: 500,
      minLegOi: 500,
      maxChainAgeMs: 30000,
      minDelta: 0.25,
      maxDelta: 0.8,
      ivMin: 8,
      ivMax: 60,
      ...cfg,
    };
  }

  /**
   * @param {object} chain      normalized chain { spot, expiry, strikes }
   * @param {'CE'|'PE'} direction
   * @param {object} [opts]     { chainAt (ms epoch), nowFn }
   */
  select(chain, direction, { chainAt = Date.now(), nowFn = Date.now } = {}) {
    const violations = [];
    const strikes = chain?.strikes || [];
    if (!Number.isFinite(chain?.spot) || strikes.length === 0) {
      return { ok: false, violations: ['EMPTY_CHAIN'], leg: null };
    }

    // ATM = strike nearest spot; apply the configured offset in strike steps.
    let atmIdx = 0;
    for (let i = 1; i < strikes.length; i++) {
      if (Math.abs(strikes[i].strike - chain.spot) < Math.abs(strikes[atmIdx].strike - chain.spot)) atmIdx = i;
    }
    const idx = Math.max(0, Math.min(strikes.length - 1, atmIdx + (this.cfg.strikeOffset || 0)));
    const row = strikes[idx];
    const leg = direction === 'CE' ? row.ce : row.pe;
    if (!leg || !Number.isFinite(leg.last_price) || leg.last_price <= 0) {
      return { ok: false, violations: ['NO_TRADABLE_LEG'], leg: null, strike: row.strike };
    }

    // Executable price: best ask for a buy; fall back to LTP.
    const ask = leg.top_ask_price > 0 ? leg.top_ask_price : leg.last_price;
    const bid = leg.top_bid_price > 0 ? leg.top_bid_price : null;
    const mid = bid != null ? (ask + bid) / 2 : ask;
    const spreadPct = mid > 0 && bid != null ? ((ask - bid) / mid) * 100 : null;

    if (spreadPct != null && spreadPct > this.cfg.maxSpreadPct) violations.push(`SPREAD_${spreadPct.toFixed(1)}PCT`);
    if ((leg.volume || 0) < this.cfg.minLegVolume) violations.push(`LOW_VOLUME_${leg.volume || 0}`);
    if ((leg.oi || 0) < this.cfg.minLegOi) violations.push(`LOW_OI_${leg.oi || 0}`);

    const iv = leg.implied_volatility;
    if (iv != null && (iv < this.cfg.ivMin || iv > this.cfg.ivMax)) violations.push(`IV_${iv.toFixed(1)}`);

    const delta = Math.abs(leg.greeks?.delta ?? NaN);
    if (Number.isFinite(delta) && (delta < this.cfg.minDelta || delta > this.cfg.maxDelta)) {
      violations.push(`DELTA_${delta.toFixed(2)}`);
    }

    const age = nowFn() - chainAt;
    if (age > this.cfg.maxChainAgeMs) violations.push(`STALE_CHAIN_${Math.round(age / 1000)}S`);

    return {
      ok: violations.length === 0,
      violations,
      leg,
      strike: row.strike,
      entryPrice: round2(ask),
      ask: round2(ask),
      bid: bid != null ? round2(bid) : null,
      spreadPct: spreadPct != null ? round2(spreadPct) : null,
      securityId: leg.security_id,
      iv: iv != null ? round2(iv) : null,
      delta: Number.isFinite(delta) ? round3(delta) : null,
    };
  }
}

const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : 0);
const round3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : 0);
