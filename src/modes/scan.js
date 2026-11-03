/**
 * `scan` mode - live signal scanner + paper trader.
 *
 * Layered pipeline per underlying (mirrors the reference architecture):
 *
 *   DhanHQ data (REST candles + option chain, WS ticks)
 *     -> CandleAggregator (REST + WS merge)
 *     -> MarketContextEngine (regime, ADX/RSI/ATR/VWAP features)   [Layer 1]
 *     -> StrategyRegistry (five deterministic families -> candidates)
 *     -> Selector: deterministic highest-score OR Tev1 via ollama-sdk
 *        (fail-closed: every failure mode is NO_TRADE)             [Layer 2]
 *     -> OptionSelector (ATM leg, best-ask entry, liquidity filters)
 *     -> RiskManager (hard gate: limits, daily loss, circuit breaker)[Layer 3]
 *     -> PaperBroker (SL-M simulation, target, trailing, 15:15 square-off)
 *     -> DecisionJournal (every decision incl. NO_TRADE), CSVs,
 *        Telegram alerts, daily report.
 *
 * The bot never places real orders - there is no order API in this codebase.
 */

import path from 'node:path';
import { loadConfig, assertCredentials } from '../config.js';
import { BotLogger } from '../logger.js';
import { DhanClient } from '../dhan/client.js';
import { InstrumentMaster } from '../dhan/instruments.js';
import { MarketData } from '../dhan/marketData.js';
import { FeedClient } from '../dhan/feed.js';
import { CandleAggregator } from '../market/candleAggregator.js';
import { buildMarketContext } from '../context/marketContext.js';
import { StrategyRegistry } from '../strategies/registry.js';
import { computeChainMetrics, computeChainBias } from '../strategy/chainAnalytics.js';
import { OptionSelector } from '../options/selector.js';
import { RiskManager } from '../risk/manager.js';
import { DecisionJournal } from '../decision/journal.js';
import { createTev1Selector, buildTev1State, deterministicSelect } from '../decision/tev1.js';
import { PaperBroker } from '../paper/broker.js';
import { TelegramNotifier } from '../notify/telegram.js';
import { generateDailyReport } from '../report.js';
import { istParts, isMarketOpen, isPastHHMM } from '../ist.js';

const SUBSCRIBE_RADIUS = 3;   // ATM +/- 3 strikes on the websocket
const UNSUBSCRIBE_RADIUS = 6; // release legs once ATM drifts this far

export async function runScan({ cfgOverride = null, force = false, once = false } = {}) {
  const cfg = cfgOverride || loadConfig();
  assertCredentials(cfg);

  const logger = new BotLogger(cfg.dataDir);
  const telegram = new TelegramNotifier({ ...cfg.telegram, logger });
  const client = new DhanClient({ clientId: cfg.clientId, accessToken: cfg.accessToken, logger });
  const marketData = new MarketData(client, logger);
  const master = new InstrumentMaster({ dataDir: cfg.dataDir, logger });

  logger.info(`DhanHQ Options Bot starting (PAPER TRADING ONLY - no orders are ever placed).`);
  await master.load(cfg.instruments.map((i) => i.symbol));

  // ---------------- market hours gate ----------------
  if (!force) {
    if (isPastHHMM('15:15')) {
      const today = istParts().date;
      const rep = generateDailyReport(today, { dataDir: cfg.dataDir, telegram, logger });
      logger.info(`Market session over (past 15:15 IST). Daily report: ${rep.file}`);
      return;
    }
    while (!isMarketOpen(new Date(), cfg.holidays)) {
      logger.info('Market closed - waiting for 09:15 IST Mon-Fri session...');
      await sleep(30000);
      if (isPastHHMM('15:15')) {
        logger.info('Session never opened today. Exiting.');
        return;
      }
    }
  }

  // ---------------- resolve underlyings + expiries ----------------
  const watch = [];
  for (const instrument of cfg.instruments) {
    const underlying = master.resolveUnderlying(instrument);
    const legSegment = underlying.exchange === 'BSE' ? 'BSE_FNO' : 'NSE_FNO';

    let expiry = null;
    try {
      const list = await marketData.expiryList(underlying);
      const today = istParts().date;
      const future = (list || []).filter((d) => d >= today).sort();
      const masterPick = master.nearestExpiry(instrument.symbol, instrument.expiryPreference);
      if (future.length > 0) {
        expiry = (masterPick && future.includes(masterPick)) ? masterPick : future[0];
      }
    } catch (err) {
      logger.warn(`Expiry list failed for ${instrument.symbol}: ${err.message}`);
    }
    if (!expiry) expiry = master.nearestExpiry(instrument.symbol, instrument.expiryPreference);
    if (!expiry) {
      logger.warn(`No tradable expiry found for ${instrument.symbol} - skipping it.`);
      continue;
    }

    watch.push({
      instrument, underlying, legSegment, expiry,
      aggregator: new CandleAggregator(cfg.candles?.interval || 5),
      restCandles: [], chain: null, metrics: null, chainAt: 0,
      subscribedLegIds: new Set(),
      state: { lastSignalAt: 0, signalsToday: 0, day: istParts().date },
    });
    logger.info(`Watching ${instrument.symbol} (${underlying.segment}:${underlying.securityId}) ` +
      `expiry ${expiry}${instrument.expiryPreference === 'weekly' ? ' [weekly]' : ' [monthly]'}`);
  }
  if (watch.length === 0) throw new Error('No instruments could be resolved - check config.instruments.');

  // ---------------- Layer 1/2/3 engines ----------------
  const registry = new StrategyRegistry({
    strategies: cfg.strategies,
    chainConfirmation: cfg.chainConfirmation,
  });
  const optionSelector = new OptionSelector(cfg.options);
  const riskManager = new RiskManager(cfg.risk, {
    signalWindow: cfg.decision.signalWindow,
    nowFn: () => new Date(),
  });
  const journal = new DecisionJournal(cfg.dataDir, { logger });
  const broker = new PaperBroker(cfg.risk, {
    statePath: path.join(cfg.dataDir, 'positions.json'),
    logger,
  });
  wireBrokerEvents(broker, { logger, telegram, cfg, riskManager });

  // Selector: 'tev1' | 'deterministic' | 'auto' (auto = tev1 when OLLAMA_BASE_URL is set).
  let tev1 = null;
  const selectorMode = cfg.decision.selector || 'auto';
  if (selectorMode === 'tev1' || (selectorMode === 'auto' && process.env.OLLAMA_BASE_URL)) {
    tev1 = await createTev1Selector({ ...cfg.decision.tev1 }, { logger });
    if (tev1) logger.info(`Tev1 selector active (model ${cfg.decision.tev1?.model || 'tev1:0.8b'}, ` +
      `min confidence ${cfg.decision.tev1?.minConfidence ?? 0.55}, timeout ${cfg.decision.tev1?.timeoutMs ?? 3000}ms).`);
    else logger.warn('Tev1 selector unavailable - falling back to deterministic selection.');
  }
  logger.info(`Decision selector: ${tev1 ? 'tev1 (fail-closed)' : 'deterministic'}`);
  telegram.send(`DhanHQ Options Bot started (PAPER MODE).\n` +
    `Watching: ${watch.map((w) => w.instrument.symbol).join(', ')}\n` +
    `Selector: ${tev1 ? 'Tev1 + deterministic layers' : 'deterministic'}\n` +
    `Square-off: ${cfg.risk.squareOffTime} IST | SL ${cfg.risk.stopLossPct}% | TGT ${cfg.risk.targetPct}% | Trail ${cfg.risk.trailPct}%`);

  // ---------------- live feed ----------------
  let feed = null;
  if (cfg.scanner.useWebSocket) {
    feed = new FeedClient({ clientId: cfg.clientId, accessToken: cfg.accessToken, logger });
    feed.connect();
    feed.on('tick', (t) => {
      broker.onTick(t.securityId, t.ltp);
      for (const w of watch) {
        if (t.securityId === w.underlying.securityId && t.segment === w.underlying.segment) {
          w.aggregator.onTick(Date.now(), t.ltp);
        }
      }
    });
    for (const w of watch) {
      feed.subscribe([{ segment: w.underlying.segment, securityId: w.underlying.securityId }]);
    }
  }

  let stopped = false;
  let reportSent = false;

  // ---------------- candle refresher (REST) ----------------
  async function refreshCandles() {
    for (const w of watch) {
      try {
        const today = istParts().date;
        w.restCandles = await marketData.intradayCandles(
          w.underlying, cfg.candles?.interval || 5,
          `${today} 09:15:00`, `${today} 15:30:00`,
        );
      } catch (err) {
        logger.warn(`Candles failed for ${w.instrument.symbol}: ${err.message}`);
      }
    }
  }
  await refreshCandles();
  const candleTimer = setInterval(refreshCandles, cfg.candles?.refreshMs || 60000);

  // ---------------- option chain rotation ----------------
  let rotationIdx = 0;
  async function pollNextChain() {
    const w = watch[rotationIdx % watch.length];
    rotationIdx++;
    try {
      const chain = await marketData.optionChain(w.underlying, w.expiry);
      w.chain = chain;
      w.chainAt = Date.now();
      try {
        w.metrics = computeChainMetrics(chain, { atmWindow: 2 });
        w.metrics.chainBias = computeChainBias(w.metrics, {
          bullish: cfg.chain?.pcrBullish ?? 1.1,
          bearish: cfg.chain?.pcrBearish ?? 0.8,
        });
      } catch (err) {
        w.metrics = null;
        logger.warn(`Chain metrics failed for ${w.instrument.symbol}: ${err.message}`);
      }
      if (feed) syncFeedSubscriptions(feed, w, chain);
    } catch (err) {
      logger.warn(`Option chain failed for ${w.instrument.symbol}: ${err.message}`);
    }
  }
  const chainTimer = setInterval(pollNextChain, Math.max(cfg.scanner.chainPollMs || 4000, 3500));

  // ---------------- the decision pipeline ----------------
  const minScore = cfg.decision.minScore ?? 0.45;

  function symbolState(w) {
    const today = istParts().date;
    if (w.state.day !== today) w.state = { lastSignalAt: 0, signalsToday: 0, day: today };
    return w.state;
  }

  async function evaluateAll() {
    for (const w of watch) {
      if (stopped) return;
      const candles = w.aggregator.merge(w.restCandles);
      if (candles.length === 0 || !w.metrics) continue;

      const context = buildMarketContext(candles, w.metrics, {
        ...cfg.context,
        emaFast: cfg.candles?.emaFast ?? 9,
        emaSlow: cfg.candles?.emaSlow ?? 21,
      });
      const snapshotId = `${w.instrument.symbol}|${context.lastCandleTs}|${w.chainAt}`;

      // Snapshot de-dup: an identical snapshot never re-decides (also makes
      // duplicate order intents impossible).
      if (!journal.shouldEvaluate(w.instrument.symbol, snapshotId)) continue;
      journal.markDecided(w.instrument.symbol, snapshotId);

      // Layer 1: deterministic candidates.
      const candidates = registry.evaluateAll({ candles, context, chainMetrics: w.metrics });
      const eligibleIds = candidates.map((c) => c.strategyId);

      const recordDecision = (decision, extra = {}) => journal.record({
        snapshotId, symbol: w.instrument.symbol, context,
        eligible: eligibleIds, selector: tev1 ? 'tev1' : 'deterministic',
        ...decision, ...extra,
      });

      const st = symbolState(w);
      const nowMs = Date.now();
      if (st.signalsToday >= (cfg.decision.maxSignalsPerDay ?? 10)) {
        recordDecision({ decision: 'NO_TRADE', reason: 'MAX_SIGNALS_DAY' });
        continue;
      }
      if (st.lastSignalAt && nowMs - st.lastSignalAt < (cfg.decision.cooldownMinutes ?? 15) * 60000) {
        recordDecision({ decision: 'NO_TRADE', reason: 'COOLDOWN' });
        continue;
      }
      if (candidates.length === 0) {
        recordDecision({ decision: 'NO_TRADE', reason: 'NO_ELIGIBLE_CANDIDATES' });
        continue;
      }

      // Layer 2: strategy selection - deterministic or Tev1 (fail-closed).
      let selection;
      let confidence = null;
      let probabilities = null;
      if (tev1) {
        const state = buildTev1State({
          snapshotId, symbol: w.instrument.symbol, expiry: { daysToExpiry: daysToExpiry(w.expiry) },
          context, candidates,
          portfolio: { openPositions: broker.openCount, dailyPnl: broker.totalPnl() },
        });
        selection = await tev1.select({ state, candidates: enrichForModel(candidates, registry) });
        confidence = selection.confidence ?? null;
        probabilities = selection.probabilities ?? null;
      } else {
        selection = deterministicSelect(candidates, { minScore });
        confidence = selection.confidence ?? null;
      }
      if (selection.status !== 'SELECTED') {
        recordDecision({ decision: 'NO_TRADE', reason: selection.reason, confidence });
        continue;
      }
      const candidate = candidates.find((c) => c.strategyId === selection.strategyId);

      // Option contract construction + liquidity filters.
      const option = optionSelector.select(w.chain, candidate.direction, {
        chainAt: w.chainAt,
        nowFn: Date.now,
      });
      if (!option.ok) {
        recordDecision({ decision: 'NO_TRADE', reason: 'OPTION_FILTER', selected: candidate.strategyId,
          confidence, violations: option.violations });
        continue;
      }

      // Layer 3: hard risk gate.
      const lotSize = master.lotSizeFor(w.instrument.symbol, w.expiry) || 1;
      const lots = w.instrument.lots ?? 1;
      const qty = lots * lotSize;
      const entry = option.entryPrice;
      const trade = {
        symbol: w.instrument.symbol,
        entryPrice: entry,
        stopTrigger: round2(entry * (1 - cfg.risk.stopLossPct / 100)),
        targetPrice: round2(entry * (1 + cfg.risk.targetPct / 100)),
        qty,
        openPositions: broker.openCount,
        dailyPnl: broker.totalPnl(),
        optionViolations: option.violations,
        force,
      };
      const risk = riskManager.review(trade);
      if (!risk.passed) {
        recordDecision({ decision: 'NO_TRADE', reason: 'RISK_REJECTED', selected: candidate.strategyId,
          confidence, violations: risk.violations });
        continue;
      }

      // Paper execution.
      const signal = {
        ...candidate,
        symbol: w.instrument.symbol,
        strike: option.strike,
        expiry: w.expiry,
        optionSecurityId: option.securityId,
        premium: option.leg.last_price,
        signalId: `S${istParts().date.replaceAll('-', '')}-${++st.signalsToday}`,
        reason: `${candidate.strategyId}: ${JSON.stringify(candidate.evidence)}`,
      };
      st.lastSignalAt = nowMs;
      const pos = broker.openPosition(signal, {
        lotSize, lots,
        tradingSymbol: master.leg(w.instrument.symbol, w.expiry, option.strike, candidate.direction)?.tradingSymbol
          ?? `${w.instrument.symbol}-${option.strike}-${candidate.direction}`,
        legSegment: w.legSegment,
        tickSize: master.leg(w.instrument.symbol, w.expiry, option.strike, candidate.direction)?.tickSize ?? 0.05,
        entryPrice: entry,
      });
      if (!pos) {
        recordDecision({ decision: 'NO_TRADE', reason: 'ALREADY_IN_LEG', selected: candidate.strategyId, confidence });
        continue;
      }

      logger.logSignal({
        at: signal.at || new Date().toISOString(),
        signalId: signal.signalId,
        symbol: signal.symbol,
        strategyId: candidate.strategyId,
        selector: tev1 ? 'tev1' : 'deterministic',
        confidence,
        direction: candidate.direction,
        score: candidate.score,
        spot: context.spot,
        regime: context.regime,
        strike: option.strike,
        expiry: signal.expiry,
        optionSecurityId: option.securityId,
        premium: option.leg.last_price,
        iv: option.iv,
        spreadPct: option.spreadPct,
        reason: signal.reason,
      });
      recordDecision({
        decision: 'SIGNAL', reason: 'ENTRY', selected: candidate.strategyId,
        confidence, probabilities,
      });
      telegram.send(
        `SIGNAL -> PAPER ENTRY\n` +
        `BUY ${w.instrument.symbol} ${option.strike} ${candidate.direction} (exp ${w.expiry})\n` +
        `strategy ${candidate.strategyId} (score ${candidate.score}${tev1 ? `, model conf ${confidence}` : ''})\n` +
        `qty ${pos.qty} @ ${pos.entryPrice}\n` +
        `SL ${pos.stopTrigger} | TGT ${pos.targetPrice} | Trail ${cfg.risk.trailPct}%\n` +
        `regime ${context.regime} | IV ${option.iv ?? 'n/a'} | spread ${option.spreadPct ?? 'n/a'}%`
      );
    }
  }
  const evalTimer = setInterval(() => { evaluateAll().catch((e) => logger.error(`evaluate: ${e.message}`)); }, 5000);

  // ---------------- position monitor (REST fallback) ----------------
  const fallbackTimer = setInterval(async () => {
    if (stopped) return;
    const open = broker.positions.filter((p) => p.status === 'OPEN');
    if (open.length === 0) return;
    const stale = open.filter((p) => !feed || feed.getLtp(p.legSegment, p.optionSecurityId, 20000) == null);
    if (stale.length === 0) return;
    try {
      const bySegment = {};
      for (const p of stale) (bySegment[p.legSegment] ??= []).push(p.optionSecurityId);
      const res = await client.ltp(bySegment);
      for (const [segment, ids] of Object.entries(res?.data || {})) {
        for (const [secId, q] of Object.entries(ids)) {
          if (q?.last_price) broker.onTick(parseInt(secId, 10), q.last_price);
        }
      }
    } catch (err) {
      logger.warn(`LTP fallback poll failed: ${err.message}`);
    }
  }, cfg.scanner.wsFallbackPollMs || 2500);

  // ---------------- square-off + shutdown ----------------
  const clockTimer = setInterval(async () => {
    if (stopped) return;
    if (!force && isPastHHMM('15:30')) {
      logger.info('Market closed (15:30 IST).');
      await shutdown('MARKET_CLOSE');
      return;
    }
    if (isPastHHMM(cfg.risk.squareOffTime)) {
      logger.info(`Square-off time ${cfg.risk.squareOffTime} IST reached - closing all paper positions.`);
      broker.squareOffAll('TIME_EXIT');
      await shutdown('SQUARE_OFF');
    }
  }, 5000);

  async function shutdown(reason) {
    if (stopped) return;
    stopped = true;
    clearInterval(candleTimer); clearInterval(chainTimer);
    clearInterval(evalTimer); clearInterval(fallbackTimer); clearInterval(clockTimer);
    if (feed) feed.close();
    broker.squareOffAll('TIME_EXIT');
    if (!reportSent) {
      reportSent = true;
      const today = istParts().date;
      const rep = generateDailyReport(today, { dataDir: cfg.dataDir, telegram, logger, journal });
      telegram.send(`Bot stopped (${reason}). Decisions: ${journal.counts.total} ` +
        `(signals ${journal.counts.signals}, rejected ${journal.counts.rejected}, no-trade ${journal.counts.noTrade}). ` +
        `Report: ${path.basename(rep.file)}`);
    }
    logger.info(`Bot stopped (${reason}).`);
    setTimeout(() => process.exit(0), 2500);
  }

  process.on('SIGINT', () => { logger.info('SIGINT received.'); shutdown('SIGINT'); });
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (once) {
    await pollNextChain();
    await refreshCandles();
    await evaluateAll();
    logger.info(`--once complete: ${journal.counts.total} decision(s), ${broker.openCount} open paper position(s).`);
    await shutdown('ONCE');
    return;
  }

  logger.info('Scanner running. Ctrl+C to stop.');
  await new Promise(() => {});
}

/* ------------------------------- helpers ------------------------------- */

function enrichForModel(candidates, registry) {
  const byId = new Map(registry.list().map((d) => [d.strategyId, d]));
  return candidates.map((c) => ({ ...c, description: byId.get(c.strategyId)?.description || c.strategyId }));
}

function daysToExpiry(expiryStr) {
  const t = Date.parse(`${expiryStr}T23:59:59+05:30`);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((t - Date.now()) / 86400000));
}

/**
 * Keep websocket subscriptions centred on the live ATM:
 * subscribe ATM +/- SUBSCRIBE_RADIUS strikes, release legs beyond UNSUBSCRIBE_RADIUS.
 */
function syncFeedSubscriptions(feed, w, chain) {
  if (!chain?.strikes?.length || !Number.isFinite(chain.spot)) return;
  const sorted = chain.strikes;
  let atmIdx = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].strike - chain.spot) < Math.abs(sorted[atmIdx].strike - chain.spot)) atmIdx = i;
  }

  const wanted = new Set();
  for (let i = Math.max(0, atmIdx - SUBSCRIBE_RADIUS); i <= Math.min(sorted.length - 1, atmIdx + SUBSCRIBE_RADIUS); i++) {
    const row = sorted[i];
    for (const leg of [row.ce, row.pe]) {
      if (leg?.security_id) wanted.add(leg.security_id);
    }
  }

  const toSubscribe = [...wanted].filter((id) => !w.subscribedLegIds.has(id))
    .map((id) => ({ segment: w.legSegment, securityId: id }));
  const toUnsubscribe = [...w.subscribedLegIds]
    .filter((id) => {
      const idx = sorted.findIndex((s) => s.ce?.security_id === id || s.pe?.security_id === id);
      if (idx < 0) return true;
      return Math.abs(idx - atmIdx) > UNSUBSCRIBE_RADIUS;
    })
    .map((id) => ({ segment: w.legSegment, securityId: id }));

  if (toSubscribe.length) feed.subscribe(toSubscribe);
  if (toUnsubscribe.length) feed.unsubscribe(toUnsubscribe);
  w.subscribedLegIds = new Set([...w.subscribedLegIds, ...wanted]
    .filter((id) => !toUnsubscribe.some((u) => u.securityId === id)));
}

function wireBrokerEvents(broker, { logger, telegram, cfg, riskManager }) {
  broker.on('entry', (p) => {
    logger.info(`PAPER ENTRY ${p.optionTradingSymbol} qty ${p.qty} @ ${p.entryPrice} ` +
      `(SL-M ${p.stopTrigger}, TGT ${p.targetPrice})`);
  });
  broker.on('trail-start', (p) => {
    telegram.send(`TRAILING STOP ARMED\n${p.optionTradingSymbol} +${cfg.risk.trailActivatePct}% - stop now trails ${cfg.risk.trailPct}% below the high.`);
  });
  broker.on('trail-move', (p) => {
    logger.info(`TRAIL SL ${p.optionTradingSymbol} moved to ${p.stopTrigger}`);
  });
  broker.on('exit', (t) => {
    riskManager?.onTradeClosed(t.pnl);
    logger.logTrade({
      id: t.id,
      openedAt: t.openedAt,
      closedAt: t.closedAt || '',
      symbol: t.symbol,
      strategyId: t.strategyId || '',
      direction: t.direction,
      optionTradingSymbol: t.optionTradingSymbol,
      optionSecurityId: t.optionSecurityId,
      expiry: t.expiry,
      strike: t.strike,
      qty: t.qty,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      exitReason: t.exitReason,
      charges: t.charges ?? '',
      pnl: t.pnl,
      score: t.score,
    });
    telegram.send(`PAPER EXIT\n${t.optionTradingSymbol} @ ${t.exitPrice}\nReason: ${t.exitReason}\n` +
      `P&L: ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)} INR (qty ${t.qty}, charges ${t.charges ?? 0})`);
  });
}

const round2 = (v) => Math.round(v * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
