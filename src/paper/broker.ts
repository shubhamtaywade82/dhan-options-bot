/**
 * Paper trading broker.
 *
 * Simulates, tick by tick, exactly what a live setup would do:
 *   - BUY entry at the best ask plus slippage ticks,
 *   - a broker-side STOP-LOSS-MARKET order resting at entry*(1-SL%)
 *     (as a Super/Bracket order would do live),
 *   - a target limit order at entry*(1+TGT%),
 *   - a trailing stop that activates at +trailActivate% and then
 *     ratchets the trigger to highWater*(1-trailPct%),
 *   - an intraday square-off at 15:15 IST,
 *   - a charges model (brokerage per executed order + slippage ticks)
 *     so paper P&L is not delusionally optimistic.
 *
 * NO REAL ORDER IS EVER PLACED - this module never touches any order API.
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { istStamp } from '../ist.js';

let nextId = 1;

const DEFAULT_CHARGES = { brokeragePerOrder: 0, slippageTicks: 0 };

export class PaperBroker extends EventEmitter {
  cfg: any;
  charges: any;
  logger: any;
  now: () => Date;
  statePath: string | null;
  positions: any[];

  /**
   * @param {object} cfg risk config { stopLossPct, targetPct, trailActivatePct, trailPct,
   *                  squareOffTime, charges: { brokeragePerOrder, slippageTicks } }
   * @param {object} [opts] { statePath, logger, nowFn }
   */
  constructor(cfg, { statePath = null, logger = null, nowFn = () => new Date() } = {}) {
    super();
    this.cfg = cfg;
    this.charges = { ...DEFAULT_CHARGES, ...(cfg.charges || {}) };
    this.logger = logger;
    this.now = nowFn;
    this.statePath = statePath;
    this.positions = [];        // all positions, open + closed (single source of truth)
    this._loadState();
  }

  get closedTrades() { return this.positions.filter((p) => p.status === 'CLOSED'); }

  /** Realized P&L of closed trades (net of charges). */
  realizedPnl() { return this.closedTrades.reduce((a, t) => a + t.pnl, 0); }

  /** Mark-to-market P&L of open positions (before exit charges). */
  openPnl() {
    return this.positions
      .filter((p) => p.status === 'OPEN')
      .reduce((acc, p) => acc + (p.lastPrice - p.entryPrice) * p.qty, 0);
  }

  /** Realized + unrealized, net of exit-side charges estimate. */
  totalPnl() { return this.realizedPnl() + this.openPnl(); }

  /* ------------------------------- entries ------------------------------- */

  /**
   * Open a paper position from a scanner signal.
   * Entry fill = best ask (or supplied price) + slippage ticks.
   * @param {object} signal  candidate/signal (direction, strike, optionSecurityId, ...)
   * @param {object} extras  { lotSize, lots, tradingSymbol, legSegment, tickSize, entryPrice? }
   */
  openPosition(signal, extras) {
    if (this.positions.some((p) => p.optionSecurityId === signal.optionSecurityId && p.status === 'OPEN')) {
      return null; // already in this leg - duplicate intents are impossible
    }
    const tickSize = extras.tickSize || 0.05;
    const slip = (this.charges.slippageTicks || 0) * tickSize;
    const rawEntry = extras.entryPrice ?? signal.premium;
    const entry = round2(rawEntry + slip);            // buy fills at ask + slippage
    const lotSize = extras.lotSize || 1;
    const qty = (extras.lots ?? 1) * lotSize;

    const stopTrigger = round2(entry * (1 - this.cfg.stopLossPct / 100));
    const targetPrice = round2(entry * (1 + this.cfg.targetPct / 100));

    const position = {
      id: `P${String(nextId++).padStart(4, '0')}`,
      signalId: signal.signalId || null,
      strategyId: signal.strategyId || null,
      openedAt: this.now().toISOString(),
      symbol: signal.symbol,
      direction: signal.direction,
      optionTradingSymbol: extras.tradingSymbol || `${signal.symbol}-${signal.strike}-${signal.direction}`,
      optionSecurityId: signal.optionSecurityId,
      legSegment: extras.legSegment || null,
      expiry: signal.expiry,
      strike: signal.strike,
      lotSize,
      lots: extras.lots ?? 1,
      qty,
      tickSize,
      entryPrice: entry,
      stopTrigger,          // simulated broker-side SL-M trigger
      initialStopTrigger: stopTrigger,
      targetPrice,
      trailActive: false,
      highWater: entry,
      status: 'OPEN',
      lastPrice: entry,
      score: signal.score ?? signal.confidence ?? null,
      reason: signal.reason || null,
      events: [{ at: this.now().toISOString(), event: 'OPEN', price: entry }],
    };

    this.positions.push(position);
    this._persist();
    this.emit('entry', position);
    return position;
  }

  /* ------------------------------- ticking ------------------------------- */

  /**
   * Feed one LTP tick for an option leg. The simulated resting orders
   * (SL-M / target / trailing) are evaluated exactly like an exchange would.
   */
  onTick(securityId, price, at = null) {
    if (!Number.isFinite(price) || price <= 0) return;
    for (const p of this.positions) {
      if (p.status !== 'OPEN' || p.optionSecurityId !== securityId) continue;
      p.lastPrice = price;
      p.highWater = Math.max(p.highWater, price);

      // Trailing stop activation + ratchet.
      const gainPct = ((price - p.entryPrice) / p.entryPrice) * 100;
      if (!p.trailActive && gainPct >= this.cfg.trailActivatePct) {
        p.trailActive = true;
        this._event(p, 'TRAIL_ARMED', price);
        this.emit('trail-start', p);
      }
      if (p.trailActive) {
        const newTrigger = round2(p.highWater * (1 - this.cfg.trailPct / 100));
        if (newTrigger > p.stopTrigger) {
          p.stopTrigger = newTrigger;
          this._event(p, 'TRAIL_MOVE', newTrigger);
          this.emit('trail-move', p);
        }
      }

      // Target limit order fill (limit orders fill at the limit price).
      if (price >= p.targetPrice) {
        this._close(p, p.targetPrice, 'TARGET');
        continue;
      }
      // Stop-loss-market order fill: trigger or worse, minus slippage ticks.
      if (price <= p.stopTrigger) {
        const reason = p.stopTrigger > p.initialStopTrigger ? 'TRAIL_SL' : 'SL';
        const fill = round2(Math.min(p.stopTrigger, price) - (this.charges.slippageTicks || 0) * p.tickSize);
        this._close(p, fill, reason);
      }
    }
  }

  get openCount() { return this.positions.filter((p) => p.status === 'OPEN').length; }

  /** Square off every open position (15:15 IST or shutdown) at LTP minus slippage. */
  squareOffAll(reason = 'TIME_EXIT') {
    for (const p of [...this.positions]) {
      if (p.status !== 'OPEN') continue;
      const fill = round2(p.lastPrice - (this.charges.slippageTicks || 0) * p.tickSize);
      this._close(p, fill, reason);
    }
    this._persist();
  }

  /* ------------------------------- internals ------------------------------ */

  _event(p, event, price) {
    p.events.push({ at: this.now().toISOString(), event, price: round2(price) });
    if (p.events.length > 50) p.events.splice(0, p.events.length - 50);
  }

  _close(p, exitPrice, reason) {
    if (p.status !== 'OPEN') return;
    p.status = 'CLOSED';
    p.exitPrice = round2(exitPrice);
    p.exitReason = reason;
    p.closedAt = this.now().toISOString();
    const charges = (this.charges.brokeragePerOrder || 0) * 2; // entry leg + exit leg
    p.charges = round2(charges);
    p.pnl = round2((p.exitPrice - p.entryPrice) * p.qty - charges);
    this._event(p, `CLOSE_${reason}`, p.exitPrice);

    this._persist();
    this.emit('exit', { ...p, events: [...p.events] });
    this.logger?.info(`PAPER EXIT ${p.optionTradingSymbol} @ ${p.exitPrice} (${reason}) ` +
      `P&L ${p.pnl >= 0 ? '+' : ''}${p.pnl.toFixed(2)} [${istStamp(this.now())}]`);
  }

  _persist() {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify({
        positions: this.positions,
        nextId,
      }, null, 2), 'utf8');
    } catch (err) {
      this.logger?.warn(`Paper state persist failed: ${err.message}`);
    }
  }

  _loadState() {
    if (!this.statePath || !fs.existsSync(this.statePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      this.positions = raw.positions || [];
      // Positions from a previous day cannot still be open - square them off at last known price.
      const today = istStamp(this.now()).slice(0, 10);
      for (const p of this.positions) {
        if (p.status === 'OPEN' && !String(p.openedAt).startsWith(today)) {
          this._close(p, p.lastPrice || p.entryPrice, 'STALE_SQUAREOFF');
        }
      }
      const maxId = this.positions.reduce((m, p) => {
        const n = parseInt(String(p.id || '').replace(/^P/, ''), 10);
        return Number.isFinite(n) ? Math.max(m, n) : m;
      }, 0);
      nextId = Math.max(nextId, (raw.nextId || 1), maxId + 1);
    } catch (err) {
      this.logger?.warn(`Paper state load failed: ${err.message}`);
    }
  }
}

const round2 = (v) => Math.round(v * 100) / 100;
