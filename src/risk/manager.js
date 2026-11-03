/**
 * Risk Manager (hard safety gate - Layer 3).
 *
 * A valid signal NEVER automatically becomes an order. Before the paper
 * broker opens anything, this gate reviews the constructed trade against
 * portfolio limits and returns a report with explicit violations:
 *
 *   - trading session / entry window
 *   - max concurrent positions
 *   - daily realized + unrealized loss cap
 *   - circuit breaker (consecutive losses)
 *   - max notional and max loss per trade
 *   - stop/target validity
 *   - option-selector liquidity violations are echoed, not re-derived
 *
 * The risk manager is authoritative: when it rejects, no position opens -
 * regardless of what any model or strategy said.
 */

import { isPastHHMM, withinWindow, isMarketOpen } from '../ist.js';

export class RiskManager {
  /**
   * @param {object} cfg risk config {
   *   stopLossPct, targetPct, squareOffTime, maxConcurrentPositions,
   *   dailyLossLimit, maxNotionalPerTrade, maxLossPerTrade, consecLossesPause
   * }
   * @param {object} [opts] { signalWindow:{start,end}, nowFn }
   */
  constructor(cfg, { signalWindow = { start: '09:20', end: '15:05' }, nowFn = () => new Date() } = {}) {
    this.cfg = cfg;
    this.signalWindow = signalWindow;
    this.now = nowFn;
    this.consecutiveLosses = 0;
    this.pausedForDay = false;
    this.rejections = 0;
  }

  /** Wire broker exit events here to keep the circuit breaker honest. */
  onTradeClosed(pnl) {
    if (pnl < 0) {
      this.consecutiveLosses += 1;
      if (this.cfg.consecLossesPause && this.consecutiveLosses >= this.cfg.consecLossesPause) {
        this.pausedForDay = true;
      }
    } else if (pnl > 0) {
      this.consecutiveLosses = 0;
    }
  }

  /**
   * Review a constructed trade.
   * @param {object} p {
   *   symbol, entryPrice, stopTrigger, targetPrice, qty,
   *   openPositions, dailyPnl (realized+unrealized), optionViolations: [],
   *   force (ignore session checks - testing)
   * }
   * @returns {{passed: boolean, violations: string[]}}
   */
  review(p) {
    const violations = [];
    const now = this.now();

    if (!p.force) {
      if (!isMarketOpen(now)) violations.push('SESSION_CLOSED');
      if (!withinWindow(this.signalWindow.start, this.signalWindow.end, now)) violations.push('OUTSIDE_ENTRY_WINDOW');
    }
    if (isPastHHMM(this.cfg.squareOffTime, now)) violations.push('PAST_SQUARE_OFF');

    if ((p.openPositions ?? 0) >= (this.cfg.maxConcurrentPositions ?? 3)) violations.push('MAX_POSITIONS');

    if (this.cfg.dailyLossLimit != null && Number.isFinite(this.cfg.dailyLossLimit) && this.cfg.dailyLossLimit > 0) {
      if ((p.dailyPnl ?? 0) <= -this.cfg.dailyLossLimit) violations.push('DAILY_LOSS_LIMIT');
    }
    if (this.pausedForDay) violations.push('CIRCUIT_BREAKER');

    const notional = (p.entryPrice || 0) * (p.qty || 0);
    if (this.cfg.maxNotionalPerTrade && notional > this.cfg.maxNotionalPerTrade) violations.push('MAX_NOTIONAL');
    const perTradeLoss = (p.entryPrice - p.stopTrigger) * (p.qty || 0);
    if (this.cfg.maxLossPerTrade && perTradeLoss > this.cfg.maxLossPerTrade) violations.push('MAX_TRADE_LOSS');

    if (!(p.stopTrigger < p.entryPrice && p.entryPrice < p.targetPrice)) violations.push('INVALID_STOP_TARGET');

    for (const v of p.optionViolations || []) violations.push(`OPTION_${v}`);

    const passed = violations.length === 0;
    if (!passed) this.rejections += 1;
    return { passed, violations };
  }
}
