/**
 * Decision Journal.
 *
 * Every evaluation cycle is journaled - including NO_TRADE outcomes - so the
 * bot's behaviour is auditable after the fact: which context it saw, which
 * strategies were eligible, who selected what (deterministic or tev1), the
 * model's confidence and the exact rejection reason.
 *
 * Also enforces snapshot de-duplication: an identical snapshot (same candle
 * timestamp + same chain timestamp) cannot produce a second decision for the
 * same underlying - which also makes duplicate order intents impossible.
 */

import path from 'node:path';
import { istStamp } from '../ist.js';
import { appendCsvRow } from '../csv.js';

export class DecisionJournal {
  constructor(dataDir, { logger = null } = {}) {
    this.csvPath = path.join(dataDir, 'decisions.csv');
    this.logger = logger;
    this.lastSnapshotBySymbol = new Map();
    this.counts = { total: 0, signals: 0, noTrade: 0, rejected: 0 };
  }

  /**
   * Should this symbol be evaluated again for the given snapshot?
   * (False when nothing new arrived since the last decision.)
   */
  shouldEvaluate(symbol, snapshotId) {
    return this.lastSnapshotBySymbol.get(symbol) !== snapshotId;
  }

  /** Mark a snapshot as decided. */
  markDecided(symbol, snapshotId) {
    this.lastSnapshotBySymbol.set(symbol, snapshotId);
  }

  /**
   * Record one decision.
   * @param {object} d {
   *   snapshotId, symbol, context, eligible: [strategyId...],
   *   selector, selected, confidence,
   *   decision: 'SIGNAL' | 'NO_TRADE',
   *   reason, violations: []
   * }
   */
  record(d) {
    this.counts.total += 1;
    if (d.decision === 'SIGNAL') this.counts.signals += 1;
    else if (d.violations?.length || /RISK|FILTER/.test(d.reason || '')) { this.counts.rejected += 1; }
    else this.counts.noTrade += 1;

    const c = d.context || {};
    appendCsvRow(this.csvPath, {
      ts: istStamp(),
      snapshotId: d.snapshotId,
      symbol: d.symbol,
      regime: c.regime ?? '',
      adx: c.adx ?? '',
      rsi14: c.rsi14 ?? '',
      atrPct: c.atrPct ?? '',
      vwapDistancePct: c.vwapDistancePct ?? '',
      chainBias: c.chain?.chainBias ?? '',
      pcr: c.chain?.putCallOiRatio ?? '',
      atmIv: c.chain?.atmIv ?? '',
      eligible: (d.eligible || []).join('|'),
      selector: d.selector ?? '',
      selected: d.selected ?? '',
      confidence: d.confidence ?? '',
      decision: d.decision,
      reason: d.reason ?? '',
      violations: (d.violations || []).join('|'),
    });
    this.logger?.info(`DECISION ${d.symbol} ${d.decision} ${d.reason || ''}` +
      (d.selected ? ` [${d.selected}]` : '') + (d.confidence != null ? ` conf=${d.confidence}` : ''));
  }
}
