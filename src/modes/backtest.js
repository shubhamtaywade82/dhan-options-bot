/**
 * `backtest` mode - historical sanity check of the layered pipeline using the
 * DhanHQ "Expired Options Data" API (POST /charts/rollingoption).
 *
 * For each configured underlying it fetches 5-minute ATM call & put premium
 * series (with IV, OI and spot) for the last N days and replays the SAME
 * deterministic pipeline used live: candle aggregation -> market context ->
 * strategy registry -> deterministic selection (Tev1 is not replayed) ->
 * option construction -> risk gate -> paper broker with the charges model.
 *
 * Conservative execution assumptions: entries at the candle close plus
 * slippage ticks, stops at trigger or worse, brokerage per order. Rolling
 * data has no historical bid/ask book, so spread costs are modelled, not
 * measured - treat results as a sanity check, not a promise.
 *
 * Output: console summary + data/backtests/backtest-<date>.csv
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, assertCredentials } from '../config.js';
import { BotLogger } from '../logger.js';
import { DhanClient } from '../dhan/client.js';
import { InstrumentMaster } from '../dhan/instruments.js';
import { MarketData } from '../dhan/marketData.js';
import { buildMarketContext } from '../context/marketContext.js';
import { StrategyRegistry } from '../strategies/registry.js';
import { computeChainBias } from '../strategy/chainAnalytics.js';
import { RiskManager } from '../risk/manager.js';
import { deterministicSelect } from '../decision/tev1.js';
import { PaperBroker } from '../paper/broker.js';
import { appendCsvRow } from '../csv.js';
import { istParts } from '../ist.js';

const MAX_CHUNK_DAYS = 29; // API allows max 30 days per call

export async function runBacktest({ cfgOverride = null, days = null } = {}) {
  const cfg = cfgOverride || loadConfig();
  assertCredentials(cfg);

  const logger = new BotLogger(cfg.dataDir);
  const client = new DhanClient({ clientId: cfg.clientId, accessToken: cfg.accessToken, logger });
  const marketData = new MarketData(client, logger);
  const master = new InstrumentMaster({ dataDir: cfg.dataDir, logger });
  await master.load(cfg.instruments.map((i) => i.symbol));

  const nDays = days || cfg.backtest?.days || 30;
  const interval = cfg.backtest?.interval || cfg.candles?.interval || 5;

  const outDir = path.join(cfg.dataDir, 'backtests');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `backtest-${istParts().date}.csv`);
  if (!fs.existsSync(outFile)) {
    appendCsvRow(outFile, {
      date: '', time: '', symbol: '', strategyId: '', direction: '', entry: '', exit: '',
      exitReason: '', qty: '', charges: '', pnl: '', score: '',
    });
  }

  const registry = new StrategyRegistry({
    strategies: cfg.strategies,
    chainConfirmation: cfg.chainConfirmation,
  });
  const minScore = cfg.decision.minScore ?? 0.45;

  const summaryRows = [];
  let grandPnl = 0, grandTrades = 0, grandWins = 0;

  for (const instrument of cfg.instruments) {
    const underlying = master.resolveUnderlying(instrument);
    const expiryFlag = instrument.kind === 'index' ? 'WEEK' : 'MONTH';

    const chunks = buildChunks(nDays, MAX_CHUNK_DAYS);
    const candles = []; // { ts, open, high, low, close, volume, oi, ce:{c,iv,oi}, pe:{c,iv,oi} }

    for (const { fromDate, toDate } of chunks) {
      try {
        const { call, put } = await marketData.rollingOption({
          underlying, interval, expiryCode: 0, expiryFlag, strike: 'ATM',
          fromDate, toDate,
        });
        mergeRolling(candles, call, put);
        logger.info(`Backtest data ${instrument.symbol}: ${fromDate} -> ${toDate} ` +
          `(${call?.timestamp?.length || 0} call candles)`);
      } catch (err) {
        logger.warn(`rollingoption failed for ${instrument.symbol} ${fromDate}: ${err.message}`);
      }
    }

    if (candles.length < (cfg.context?.minCandles ?? 20) + 5) {
      logger.warn(`Not enough candles for ${instrument.symbol} - skipped.`);
      continue;
    }

    const lotSize = master.lotSizeFor(instrument.symbol, master.nearestExpiry(instrument.symbol, instrument.expiryPreference)) || 1;
    const lots = instrument.lots ?? 1;
    const broker = new PaperBroker(cfg.risk, { logger: null });
    const riskManager = new RiskManager(cfg.risk, {
      signalWindow: cfg.decision.signalWindow,
      nowFn: () => new Date(), // real clock only for logging; gates use candle minutes below
    });
    let cooldownUntilTs = 0;
    let currentDay = null;

    for (let i = (cfg.context?.minCandles ?? 20); i < candles.length; i++) {
      const c = candles[i];
      const hist = candles.slice(0, i + 1);
      const now = new Date(c.ts * 1000);
      const minutes = istMinutes(now);
      const day = istParts(now).date;

      // New day: reset the intraday circuit-breaker/loss state.
      if (day !== currentDay) {
        currentDay = day;
        riskManager.consecutiveLosses = 0;
        riskManager.pausedForDay = false;
      }

      // Manage open positions on this candle (conservative: checks on close).
      for (const p of broker.positions.filter((p) => p.status === 'OPEN')) {
        const price = p.direction === 'CE' ? c.ce.close : c.pe.close;
        broker.onTick(p.optionSecurityId, price);
      }

      // Daily square-off at 15:15 IST - never carry a position overnight.
      if (minutes >= parseMin(cfg.risk.squareOffTime)) {
        broker.squareOffAll('TIME_EXIT');
        continue;
      }

      if (minutes < parseMin(cfg.decision.signalWindow.start) || minutes >= parseMin(cfg.decision.signalWindow.end)) continue;
      if (c.ts < cooldownUntilTs) continue;

      // Layer 1: context + candidates (chain summary from ATM legs).
      const ohlc = hist.map((x) => ({
        ts: x.ts, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume,
      }));
      const metrics = {
        pcr: c.ce.oi > 0 ? c.pe.oi / c.ce.oi : null,
        atmIv: (c.ce.iv + c.pe.iv) / 2,
        nearCeOiChg: c.ce.oi - (candles[i - 1]?.ce.oi ?? c.ce.oi),
        nearPeOiChg: c.pe.oi - (candles[i - 1]?.pe.oi ?? c.pe.oi),
        nearCeOi: Math.max(c.ce.oi, 1),
        nearPeOi: Math.max(c.pe.oi, 1),
      };
      metrics.chainBias = computeChainBias(metrics, {
        bullish: cfg.chain?.pcrBullish ?? 1.1, bearish: cfg.chain?.pcrBearish ?? 0.8,
      });
      const context = buildMarketContext(ohlc, metrics, {
        ...cfg.context, emaFast: cfg.candles?.emaFast ?? 9, emaSlow: cfg.candles?.emaSlow ?? 21,
      });
      const candidates = registry.evaluateAll({ candles: ohlc, context, chainMetrics: metrics });

      // Layer 2 (deterministic replay - the model is not part of backtests).
      const selection = deterministicSelect(candidates, { minScore });
      if (selection.status !== 'SELECTED') continue;
      const candidate = candidates.find((x) => x.strategyId === selection.strategyId);

      // Option construction (entry = candle close; rolling data has no bid/ask).
      const entryPrice = candidate.direction === 'CE' ? c.ce.close : c.pe.close;
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;

      // Layer 3: risk gate (intraday limits; session gates replaced by the
      // candle-time checks above, so force=true here).
      const risk = riskManager.review({
        symbol: instrument.symbol, entryPrice,
        stopTrigger: entryPrice * (1 - cfg.risk.stopLossPct / 100),
        targetPrice: entryPrice * (1 + cfg.risk.targetPct / 100),
        qty: lots * lotSize,
        openPositions: broker.openCount,
        dailyPnl: broker.totalPnl(),
        optionViolations: [],
        force: true,
      });
      if (!risk.passed) continue;

      const signal = {
        at: now.toISOString(), symbol: instrument.symbol, direction: candidate.direction,
        strategyId: candidate.strategyId,
        score: candidate.score,
        strike: 'ATM', expiry: expiryFlag, optionSecurityId: i,
        premium: entryPrice,
      };
      const pos = broker.openPosition(signal, {
        lotSize, lots, tradingSymbol: `${instrument.symbol}-ATM-${candidate.direction}`,
        legSegment: 'BACKTEST', entryPrice, tickSize: 0.05,
      });
      if (pos) cooldownUntilTs = c.ts + (cfg.decision.cooldownMinutes ?? 15) * 60;
    }

    // Square off anything left at the last candle.
    const last = candles[candles.length - 1];
    for (const p of broker.positions.filter((p) => p.status === 'OPEN')) {
      broker.onTick(p.optionSecurityId, p.direction === 'CE' ? last.ce.close : last.pe.close);
    }
    broker.squareOffAll('EOD');

    const trades = broker.closedTrades;
    const pnl = trades.reduce((a, t) => a + t.pnl, 0);
    const wins = trades.filter((t) => t.pnl > 0).length;
    grandPnl += pnl; grandTrades += trades.length; grandWins += wins;

    for (const t of trades) {
      appendCsvRow(outFile, {
        date: t.openedAt.slice(0, 10), time: t.openedAt.slice(11, 19),
        symbol: t.symbol, strategyId: t.strategyId || '', direction: t.direction,
        entry: t.entryPrice, exit: t.exitPrice,
        exitReason: t.exitReason, qty: t.qty, charges: t.charges ?? 0, pnl: t.pnl, score: t.score,
      });
    }
    summaryRows.push({ symbol: instrument.symbol, trades: trades.length, wins, pnl });
    logger.info(`Backtest ${instrument.symbol}: ${trades.length} trades, ${wins} wins, P&L ${pnl.toFixed(2)}`);
  }

  // ---- summary ----
  console.log('\n================ BACKTEST SUMMARY ================');
  console.log(`period: last ${nDays} days | interval: ${interval}m | deterministic replay, charges modelled`);
  console.log('');
  console.log('symbol        trades   wins   win%      P&L (INR)');
  console.log('---------------------------------------------------');
  for (const r of summaryRows) {
    const winPct = r.trades ? ((r.wins / r.trades) * 100).toFixed(1) : '-';
    console.log(`${r.symbol.padEnd(12)} ${String(r.trades).padStart(6)} ${String(r.wins).padStart(6)} ` +
      `${winPct.padStart(7)} ${r.pnl.toFixed(2).padStart(13)}`);
  }
  console.log('---------------------------------------------------');
  const winPct = grandTrades ? ((grandWins / grandTrades) * 100).toFixed(1) : '-';
  console.log(`TOTAL         ${String(grandTrades).padStart(6)} ${String(grandWins).padStart(6)} ` +
    `${winPct.padStart(7)} ${grandPnl.toFixed(2).padStart(13)}`);
  console.log(`\nTrade log: ${outFile}`);
  console.log('NOTE: paper simulation on ATM rolling-option data with modelled charges - no real orders.');
}

/* ------------------------------- helpers ------------------------------- */

function buildChunks(nDays, maxChunk) {
  const chunks = [];
  const today = new Date();
  let end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  let remaining = nDays;
  while (remaining > 0) {
    const span = Math.min(remaining, maxChunk);
    const start = new Date(end.getTime() - span * 86400000);
    chunks.unshift({
      fromDate: start.toISOString().slice(0, 10),
      toDate: end.toISOString().slice(0, 10),
    });
    end = start;
    remaining -= span;
  }
  return chunks;
}

/** Merge CALL and PUT rolling series into one aligned timeline with OHLCV. */
function mergeRolling(candles, ce, pe) {
  if (!ce || !Array.isArray(ce.timestamp)) return;
  const peByTs = new Map();
  if (pe && Array.isArray(pe.timestamp)) {
    for (let i = 0; i < pe.timestamp.length; i++) {
      peByTs.set(pe.timestamp[i], {
        o: pe.open?.[i], h: pe.high?.[i], l: pe.low?.[i], c: pe.close?.[i],
        iv: pe.iv?.[i], oi: pe.oi?.[i], v: pe.volume?.[i] ?? 0,
      });
    }
  }
  for (let i = 0; i < ce.timestamp.length; i++) {
    const ts = ce.timestamp[i];
    const p = peByTs.get(ts);
    if (!p) continue; // need both legs
    const spot = ce.spot?.[i];
    candles.push({
      ts,
      spot,
      open: spot ?? ce.open?.[i],
      high: spot ?? ce.high?.[i],
      low: spot ?? ce.low?.[i],
      close: spot ?? ce.close?.[i],
      volume: (ce.volume?.[i] ?? 0) + (p.v || 0),
      ce: { o: ce.open?.[i], h: ce.high?.[i], l: ce.low?.[i], c: ce.close?.[i], iv: ce.iv?.[i] ?? 0, oi: ce.oi?.[i] ?? 0 },
      pe: p,
    });
  }
}

function istMinutes(date) {
  const p = istParts(date);
  return p.hh * 60 + p.mm;
}

function parseMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
