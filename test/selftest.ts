/**
 * Offline selftest - no credentials, no network (the ollama-sdk is exercised
 * through a stub client; the real server is never contacted).
 *   npm run selftest
 *
 *  1. IST clock utilities             8. Option selector (liquidity filters)
 *  2. WebSocket binary parser         9. Risk manager (hard gate)
 *  3. Indicators (EMA/RSI/ATR/ADX)   10. Tev1 selector (all fail-closed paths)
 *  4. Chain analytics + bias         11. Decision journal (dedupe + audit)
 *  5. Market context engine          12. Paper broker (exits, charges, slippage)
 *  6. Candle aggregator              13. CSV + instrument master
 *  7. Strategy registry (5 families) 14. Mock end-to-end pipeline + report
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { istParts, isMarketOpen, withinWindow, parseHHMM } from '../src/ist.js';
import { parseBinaryPacket, parseBinaryFrame, FeedClient } from '../src/dhan/feed.js';
import { ema, emaTrendScore, resample, rsi, atr, adx, vwap } from '../src/strategy/indicators.js';
import { computeChainMetrics, pcrScore, oiShiftScore, computeChainBias } from '../src/strategy/chainAnalytics.js';
import { buildMarketContext, REGIMES } from '../src/context/marketContext.js';
import { CandleAggregator } from '../src/market/candleAggregator.js';
import { StrategyRegistry } from '../src/strategies/registry.js';
import { OptionSelector } from '../src/options/selector.js';
import { RiskManager } from '../src/risk/manager.js';
import { DecisionJournal } from '../src/decision/journal.js';
import { Tev1StrategySelector, buildTev1State, deterministicSelect, createTev1Selector } from '../src/decision/tev1.js';
import { PaperBroker } from '../src/paper/broker.js';
import { appendCsvRow, readCsv } from '../src/csv.js';
import { InstrumentMaster } from '../src/dhan/instruments.js';
import { BotLogger } from '../src/logger.js';
import { loadConfig } from '../src/config.js';
import { generateDailyReport } from '../src/report.js';

const PROJECT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name + (detail ? ` - ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' - ' + detail : ''}`); }
}

function approx(a, b, tol = 0.01) { return Math.abs(a - b) <= tol; }

/* Zero-charges risk config so exit arithmetic is exact; charges tested separately. */
const RISK0 = {
  stopLossPct: 30, targetPct: 60, trailActivatePct: 25, trailPct: 15,
  squareOffTime: '15:15', maxConcurrentPositions: 3,
  dailyLossLimit: 5000, maxNotionalPerTrade: 400000, maxLossPerTrade: 2500, consecLossesPause: 3,
  charges: { brokeragePerOrder: 0, slippageTicks: 0 },
};

export async function runSelftest() {
  console.log('DhanHQ Options Bot selftest\n');

  await testIst();
  testFeedParser();
  testIndicators();
  testChainAnalytics();
  testMarketContext();
  testCandleAggregator();
  testStrategyRegistry();
  testOptionSelector();
  testRiskManager();
  await testTev1Selector();
  testDecisionJournal();
  testPaperBroker();
  testCsvAndInstruments();
  await testEndToEnd();

  console.log('\n-------------------------------------------');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failed checks:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log('All checks passed. Bot logic verified offline.');
}

/* ------------------------------ fixtures ------------------------------ */

/** Candles from a close series (index-like magnitudes: ~0.1% per 5-min candle). */
function makeCandles(closes, { vol = 1000, wick = 5 } = {}) {
  return closes.map((c, i) => ({
    ts: (9 * 3600 + 15 * 60 + i * 300) * 1000, // 09:15 IST onwards, 5-min steps
    open: closes[i - 1] ?? c, high: c + wick, low: c - wick, close: c,
    volume: vol, oi: 0,
  }));
}

const risingCloses = Array.from({ length: 40 }, (_, i) => 10000 + i * 10);
const fallingCloses = Array.from({ length: 40 }, (_, i) => 20000 - i * 20);
const flatCloses = Array.from({ length: 40 }, () => 10000.5);
const wildCloses = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 10000 : 10800));

const BULLISH_METRICS = { pcr: 1.4, atmIv: 12, atmStrike: 25000, chainBias: 0.6, spot: 25005 };
const BEARISH_METRICS = { pcr: 0.55, atmIv: 12, atmStrike: 25000, chainBias: -0.6, spot: 25005 };

/** Option chain fixture: ATM 25000, spot 25005, liquid legs. */
function makeChain() {
  const strikes = [];
  for (let k = -5; k <= 5; k++) {
    const strike = 25000 + k * 50;
    const ceOi = 1000 + k * 10;
    const peOi = 1000 - k * 10;
    strikes.push({
      strike,
      ce: { oi: ceOi, previous_oi: Math.round(ceOi * 0.9), volume: 5000, last_price: 100 - k * 10, implied_volatility: 12,
            top_ask_price: 100.5 - k * 10, top_bid_price: 99.5 - k * 10, security_id: 40000 + k * 2,
            greeks: { delta: 0.5, theta: -10 } },
      pe: { oi: peOi, previous_oi: Math.round(peOi * 1.1), volume: 5000, last_price: 100 + k * 10, implied_volatility: 12,
            top_ask_price: 100.5 + k * 10, top_bid_price: 99.5 + k * 10, security_id: 40001 + k * 2,
            greeks: { delta: -0.5, theta: -10 } },
    });
  }
  return { spot: 25005, expiry: '2026-11-05', strikes };
}

/* ------------------------------ 1. IST clock ------------------------------ */

async function testIst() {
  console.log('[1] IST clock utilities');

  const t = new Date('2026-11-03T05:00:00Z'); // Tuesday 10:30 IST
  const p = istParts(t);
  ok('istParts date', p.date === '2026-11-03', p.date);
  ok('istParts time', p.time === '10:30:00', p.time);
  ok('istParts weekday', p.weekday === 'Tue', p.weekday);

  ok('market open at 10:30 IST Tue', isMarketOpen(t) === true);
  ok('market closed at 09:00 IST', isMarketOpen(new Date('2026-11-03T03:30:00Z')) === false);
  ok('market closed at 15:45 IST', isMarketOpen(new Date('2026-11-03T10:15:00Z')) === false);
  ok('market closed on Saturday', isMarketOpen(new Date('2026-11-07T05:00:00Z')) === false);
  ok('holiday respected', isMarketOpen(t, ['2026-11-03']) === false);
  ok('parseHHMM', parseHHMM('15:15') === 915);
  ok('withinWindow', withinWindow('09:20', '15:05', t) === true);
  ok('outsideWindow', withinWindow('11:00', '12:00', t) === false);
}

/* --------------------------- 2. WS binary parser --------------------------- */

function buildPacket(code, segment, securityId, payload) {
  const header = Buffer.alloc(8);
  header[0] = code;
  header.writeInt16LE(payload.length, 1);
  header[3] = segment;
  header.writeInt32LE(securityId, 4);
  return Buffer.concat([header, payload]);
}

function testFeedParser() {
  console.log('[2] WebSocket binary parser');

  const tick = buildPacket(2, 2, 49081, (() => {
    const b = Buffer.alloc(8);
    b.writeFloatLE(368.15, 0);
    b.writeInt32LE(1730610000, 4);
    return b;
  })());
  const t1 = parseBinaryPacket(tick);
  ok('ticker: type/segment', t1.type === 'ticker' && t1.segment === 'NSE_FNO');
  ok('ticker: securityId', t1.securityId === 49081, String(t1.securityId));
  ok('ticker: ltp', approx(t1.ltp, 368.15), String(t1.ltp));
  ok('ticker: ltt', t1.lastTradeTime === 1730610000);

  const tick15 = Buffer.from(tick); tick15[0] = 15;
  const t1c = parseBinaryPacket(tick15);
  ok('ticker: legacy code 15', t1c.type === 'ticker' && approx(t1c.ltp, 368.15));

  const pc = buildPacket(6, 2, 49081, (() => {
    const b = Buffer.alloc(8);
    b.writeFloatLE(360.5, 0);
    b.writeInt32LE(120000, 4);
    return b;
  })());
  const t2 = parseBinaryPacket(pc);
  ok('prevclose: values', t2.type === 'prevclose' && approx(t2.prevClose, 360.5) && t2.prevOi === 120000);

  const oi = buildPacket(5, 2, 49081, (() => {
    const b = Buffer.alloc(4); b.writeInt32LE(4242, 0); return b;
  })());
  const t3 = parseBinaryPacket(oi);
  ok('oi: value', t3.type === 'oi' && t3.oi === 4242);

  const q = buildPacket(4, 2, 49081, (() => {
    const b = Buffer.alloc(42);
    b.writeFloatLE(370.25, 0);
    b.writeInt16LE(75, 4);
    b.writeInt32LE(1730610060, 6);
    b.writeFloatLE(369.1, 10);
    b.writeInt32LE(1200000, 14);
    b.writeInt32LE(15000, 18);
    b.writeInt32LE(18250, 22);
    b.writeFloatLE(355.0, 26);
    b.writeFloatLE(348.3, 30);
    b.writeFloatLE(372.4, 34);
    b.writeFloatLE(350.1, 38);
    return b;
  })());
  const t4 = parseBinaryPacket(q);
  ok('quote: ltp', t4.type === 'quote' && approx(t4.ltp, 370.25));
  ok('quote: ltq/ltt', t4.lastTradeQty === 75 && t4.lastTradeTime === 1730610060);
  ok('quote: atp/vol', approx(t4.averagePrice, 369.1) && t4.volume === 1200000);
  ok('quote: buy/sell qty', t4.buyQty === 18250 && t4.sellQty === 15000);
  ok('quote: ohlc', approx(t4.open, 355) && approx(t4.close, 348.3) && approx(t4.high, 372.4) && approx(t4.low, 350.1));

  const dc = buildPacket(50, 0, 0, (() => {
    const b = Buffer.alloc(2); b.writeInt16LE(805, 0); return b;
  })());
  ok('disconnect: reason', parseBinaryPacket(dc).reason === 805);

  const packets = parseBinaryFrame(Buffer.concat([tick, oi]));
  ok('frame: two packets', packets.length === 2 && packets[0].type === 'ticker' && packets[1].type === 'oi');

  const feed = new FeedClient({ clientId: 'x', accessToken: 'y' });
  feed.handleFrame(q);
  const snap = feed.getSnapshot('NSE_FNO', 49081, 0);
  ok('feed: cache hit', snap != null && approx(snap.ltp, 370.25));
}

/* ----------------------------- 3. Indicators ----------------------------- */

function testIndicators() {
  console.log('[3] Indicators');

  const e = ema([1, 2, 3, 4, 5], 3);
  ok('ema values', approx(e[1], 1.5, 1e-6) && approx(e[2], 2.25, 1e-6) && approx(e[4], 4.0625, 1e-6));

  ok('emaTrend rising > 0', emaTrendScore(risingCloses, { fast: 9, slow: 21 }) > 0.5);
  ok('emaTrend falling < 0', emaTrendScore(fallingCloses, { fast: 9, slow: 21 }) < -0.5);
  ok('emaTrend short = 0', emaTrendScore([1, 2, 3], { fast: 9, slow: 21 }) === 0);
  const choppy = Array.from({ length: 40 }, (_, i) => 15000 + (i % 2 === 0 ? 5 : -5));
  ok('emaTrend choppy small', Math.abs(emaTrendScore(choppy, { fast: 9, slow: 21 })) <= 0.5);

  const rUp = rsi(risingCloses, 14);
  ok('rsi rising ~100', rUp[rUp.length - 1] > 98, String(rUp[rUp.length - 1]));
  const rDown = rsi(fallingCloses, 14);
  ok('rsi falling ~0', rDown[rDown.length - 1] < 2, String(rDown[rDown.length - 1]));
  const rFlat = rsi(flatCloses, 14);
  ok('rsi flat = 50', approx(rFlat[rFlat.length - 1], 50, 0.001));

  const aCandles = makeCandles(flatCloses, { wick: 5 });
  const a = atr(aCandles, 14);
  ok('atr constant range = 10', approx(a[a.length - 1], 10, 0.1), String(a[a.length - 1]));

  const up = adx(makeCandles(risingCloses), 14);
  ok('adx rising: +DI > -DI, adx strong',
    up.plusDI[39] > up.minusDI[39] && up.adx[39] > 20, `adx=${up.adx[39]?.toFixed(1)}`);
  const down = adx(makeCandles(fallingCloses), 14);
  ok('adx falling: -DI > +DI', down.minusDI[39] > down.plusDI[39]);
  const flat = adx(aCandles, 14);
  ok('adx flat: weak', flat.adx[39] < 15, String(flat.adx[39]));

  ok('vwap volume weighted', approx(vwap([
    { high: 101, low: 99, close: 100, volume: 1 },
    { high: 201, low: 199, close: 200, volume: 3 },
  ]), 175, 0.001));

  const candles = [
    { ts: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, oi: 0 },
    { ts: 60000, open: 1.5, high: 2.5, low: 1, close: 2, volume: 20, oi: 0 },
    { ts: 120000, open: 2, high: 3, low: 1.5, close: 2.5, volume: 30, oi: 0 },
    { ts: 180000, open: 2.5, high: 3.5, low: 2, close: 3, volume: 40, oi: 0 },
    { ts: 240000, open: 3, high: 4, low: 2.5, close: 3.5, volume: 50, oi: 0 },
  ];
  const r = resample(candles, 5);
  ok('resample to one candle', r.length === 1);
  ok('resample ohlcv', r[0].open === 1 && r[0].high === 4 && r[0].low === 0.5 && r[0].close === 3.5 && r[0].volume === 150);
}

/* -------------------------- 4. Chain analytics -------------------------- */

function testChainAnalytics() {
  console.log('[4] Option chain analytics');

  const chain = makeChain();
  const m = computeChainMetrics(chain, { atmWindow: 2 });
  ok('atm strike', m.atmStrike === 25000, String(m.atmStrike));
  ok('pcr ~ 1', approx(m.pcr, 1.0, 0.05), String(m.pcr));
  ok('atm iv', approx(m.atmIv, 12, 0.001));
  ok('ce oi rising near atm', m.nearCeOiChg > 0, String(m.nearCeOiChg));
  ok('pe oi falling near atm', m.nearPeOiChg < 0, String(m.nearPeOiChg));

  ok('pcrScore bullish', pcrScore(1.4) > 0.5);
  ok('pcrScore bearish', pcrScore(0.5) < -0.5);
  ok('pcrScore neutral', Math.abs(pcrScore(0.95)) < 0.4);

  const bull = oiShiftScore({ nearCeOiChg: -200, nearPeOiChg: 300, nearCeOi: 1000, nearPeOi: 1000 });
  const bear = oiShiftScore({ nearCeOiChg: 300, nearPeOiChg: -200, nearCeOi: 1000, nearPeOi: 1000 });
  ok('oiShift bullish', bull > 0.2, String(bull));
  ok('oiShift bearish', bear < -0.2, String(bear));

  ok('chainBias bullish', computeChainBias({ pcr: 1.4, nearCeOiChg: -200, nearPeOiChg: 300, nearCeOi: 1000, nearPeOi: 1000 }) > 0.2);
  ok('chainBias bearish', computeChainBias({ pcr: 0.55, nearCeOiChg: 300, nearPeOiChg: -200, nearCeOi: 1000, nearPeOi: 1000 }) < -0.2);
}

/* -------------------------- 5. Market context -------------------------- */

function testMarketContext() {
  console.log('[5] Market context engine');

  const ctxUp = buildMarketContext(makeCandles(risingCloses), BULLISH_METRICS, {});
  ok('rising -> TREND_UP', ctxUp.regime === REGIMES.TREND_UP, ctxUp.regime);
  ok('rising: rsi high', ctxUp.rsi14 > 70, String(ctxUp.rsi14));
  ok('rising: adx strong', ctxUp.adx >= 25, String(ctxUp.adx));
  ok('rising: ema spread positive', ctxUp.emaSpreadPct > 0);
  ok('enoughData', ctxUp.enoughData === true);
  ok('chain summary attached', ctxUp.chain?.atmStrike === 25000 && approx(ctxUp.chain.chainBias, 0.6, 0.001));

  const ctxDown = buildMarketContext(makeCandles(fallingCloses), null, {});
  ok('falling -> TREND_DOWN', ctxDown.regime === REGIMES.TREND_DOWN, ctxDown.regime);

  const ctxFlat = buildMarketContext(makeCandles(flatCloses), null, {});
  ok('flat -> RANGE', ctxFlat.regime === REGIMES.RANGE, ctxFlat.regime);

  const ctxWild = buildMarketContext(makeCandles(wildCloses, { wick: 100 }), null, {});
  ok('wild -> HIGH_VOLATILITY', ctxWild.regime === REGIMES.HIGH_VOLATILITY, ctxWild.regime);

  const ctxShort = buildMarketContext(makeCandles(flatCloses.slice(0, 5)), null, {});
  ok('insufficient data -> TRANSITION', ctxShort.regime === REGIMES.TRANSITION && ctxShort.enoughData === false);

  const ctxUpNoChain = buildMarketContext(makeCandles(risingCloses), null, {});
  ok('vwap below rising price', ctxUpNoChain.vwap < ctxUpNoChain.spot && ctxUpNoChain.vwapDistancePct > 0);
  ok('support/resistance distances', ctxUpNoChain.supportDistancePct >= 0 && ctxUpNoChain.resistanceDistancePct >= 0);
}

/* -------------------------- 6. Candle aggregator -------------------------- */

function testCandleAggregator() {
  console.log('[6] Candle aggregator');

  const rest = [
    { ts: 0, open: 100, high: 101, low: 99, close: 100.5, volume: 100, oi: 0 },
    { ts: 300000, open: 100.5, high: 102, low: 100, close: 101, volume: 120, oi: 0 },
  ];

  const agg1 = new CandleAggregator(5);
  let merged = agg1.merge(rest);
  ok('no ticks: rest unchanged', merged.length === 2);

  agg1.onTick(300000 + 60_000, 101.8); // tick inside the newest rest bucket
  merged = agg1.merge(rest);
  ok('same bucket: close refreshed, no extra candle', merged.length === 2 && approx(merged[1].close, 101.8));

  agg1.onTick(600000, 102.5);          // tick in a newer bucket
  agg1.onTick(600000 + 60_000, 103);
  merged = agg1.merge(rest);
  ok('newer bucket appended', merged.length === 3 && approx(merged[2].close, 103) && approx(merged[2].high, 103));
  ok('forming ohlc', approx(merged[2].open, 102.5) && approx(merged[2].low, 102.5));

  const agg2 = new CandleAggregator(5);
  agg2.onTick(0, 99);                  // tick older than the newest rest candle
  ok('older tick ignored', agg2.merge(rest).length === 2);

  agg1.reset();
  ok('reset', agg1.merge(rest).length === 2);
}

/* -------------------------- 7. Strategy registry -------------------------- */

function testStrategyRegistry() {
  console.log('[7] Strategy registry (five deterministic families)');

  const baseCfg = {
    strategies: {
      emaCross: { enabled: true, minSpreadPct: 0.05 },
      trendContinuation: { enabled: true, vwapMaxDistancePct: 25 },
      rangeBreak: { enabled: true, rangeCandles: 3, volumeSurge: 1.2 },
      momentumBreak: { enabled: true, rocPct: 0.35, volumeSurge: 1.5 },
      trendFlip: { enabled: true, rsiOverbought: 72, rsiOversold: 28 },
    },
    chainConfirmation: { enabled: true, opposeKill: 0.2, agreeBoost: 0.15 },
  };
  const registry = new StrategyRegistry(baseCfg);

  const evalCtx = (candles, metrics) => {
    const context = buildMarketContext(candles, metrics, {});
    return { candidates: registry.evaluateAll({ candles, context, chainMetrics: metrics }), context };
  };
  const has = (candidates, id, dir = null) => candidates.some((c) => c.strategyId === id && (!dir || c.direction === dir));

  // --- ema_cross on a rising trend ---
  let { candidates } = evalCtx(makeCandles(risingCloses), BULLISH_METRICS);
  ok('ema_cross fires CE on uptrend', has(candidates, 'ema_cross', 'CE'), JSON.stringify(candidates.map((c) => c.strategyId)));
  ok('candidates carry score+evidence', candidates.every((c) => c.score >= 0 && c.score <= 1 && c.evidence));

  // --- chain opposition kills the same setup ---
  ({ candidates } = evalCtx(makeCandles(risingCloses), BEARISH_METRICS));
  ok('opposing chain kills ema_cross', !has(candidates, 'ema_cross'), JSON.stringify(candidates.map((c) => c.strategyId)));

  // --- ema_cross on falling trend -> PE ---
  ({ candidates } = evalCtx(makeCandles(fallingCloses), BEARISH_METRICS));
  ok('ema_cross fires PE on downtrend', has(candidates, 'ema_cross', 'PE'));

  // --- trend_continuation: trend, sharp pullback, resumption ---
  const tcCloses = [...Array.from({ length: 25 }, (_, i) => 10000 + i * 6)];
  for (let i = 0; i < 5; i++) tcCloses.push(tcCloses[tcCloses.length - 1] - 12);
  tcCloses.push(tcCloses[tcCloses.length - 1] + 16); // resumption candle
  let tcOut = evalCtx(makeCandles(tcCloses), BULLISH_METRICS);
  ok('trend_continuation fires after pullback-resume',
    has(tcOut.candidates, 'trend_continuation', 'CE'),
    JSON.stringify({ regime: tcOut.context.regime, rsi: tcOut.context.rsi14, spread: tcOut.context.emaSpreadPct, ids: tcOut.candidates.map((c) => c.strategyId) }));
  candidates = tcOut.candidates;

  // --- range_break: opening range breakout with volume ---
  // First 3 candles form a wide opening range; the rest stay inside it;
  // the final candle breaks out with volume.
  const rbCloses = Array.from({ length: 24 }, () => 10000.5);
  rbCloses[rbCloses.length - 1] = 10100;
  const rbCandles = rbCloses.map((c, i) => ({
    ts: i * 300000,
    open: rbCloses[i - 1] ?? c,
    high: i < 3 ? c + 30 : c + 5,
    low: i < 3 ? c - 30 : c - 5,
    close: c,
    volume: i === rbCloses.length - 1 ? 2500 : 1000,
    oi: 0,
  }));
  const rangeHigh = 10000.5 + 30, rangeLow = 10000.5 - 30;
  ({ candidates } = evalCtx(rbCandles, BULLISH_METRICS));
  ok('range_break fires on breakout', has(candidates, 'range_break', 'CE'),
    JSON.stringify({ regime: evalCtx && '', ids: candidates.map((c) => c.strategyId), rangeHigh, rangeLow, last: 10100 }));

  // --- momentum_break: burst with volume surge ---
  const mbCloses = [...Array.from({ length: 25 }, () => 10000.5), 10050, 10110, 10180];
  const mbCandles = makeCandles(mbCloses, { vol: 1000 });
  mbCandles[mbCandles.length - 1].volume = 3000;
  mbCandles[mbCandles.length - 2].volume = 2500;
  ({ candidates } = evalCtx(mbCandles, BULLISH_METRICS));
  ok('momentum_break fires on burst', has(candidates, 'momentum_break', 'CE'), JSON.stringify(candidates.map((c) => c.strategyId)));

  // --- trend_flip: exhaustion reversal with chain support ---
  const flipDownCloses = [...Array.from({ length: 39 }, (_, i) => 20000 - i * 20), 19250];
  const flipDownMetrics = { ...BULLISH_METRICS }; // bullish chain turning during a downtrend
  ({ candidates } = evalCtx(makeCandles(flipDownCloses), flipDownMetrics));
  ok('trend_flip fires CE on oversold reversal', has(candidates, 'trend_flip', 'CE'),
    JSON.stringify(candidates.map((c) => c.strategyId)));

  const flipUpCloses = [...Array.from({ length: 39 }, (_, i) => 10000 + i * 10), 10370];
  ({ candidates } = evalCtx(makeCandles(flipUpCloses), BEARISH_METRICS));
  ok('trend_flip fires PE on overbought reversal', has(candidates, 'trend_flip', 'PE'),
    JSON.stringify(candidates.map((c) => c.strategyId)));

  // --- regime gating: HIGH_VOLATILITY blocks every family ---
  ({ candidates } = evalCtx(makeCandles(wildCloses, { wick: 100 }), BULLISH_METRICS));
  ok('HIGH_VOLATILITY blocks all strategies', candidates.length === 0, JSON.stringify(candidates.map((c) => c.strategyId)));

  // --- insufficient data ---
  ({ candidates } = evalCtx(makeCandles(risingCloses.slice(0, 8)), BULLISH_METRICS));
  ok('insufficient data blocks all strategies', candidates.length === 0);

  // --- disabled strategy ---
  const regDisabled = new StrategyRegistry({
    ...baseCfg, strategies: { ...baseCfg.strategies, emaCross: { enabled: false } },
  });
  const disabledCtx = buildMarketContext(makeCandles(risingCloses), BULLISH_METRICS, {});
  ok('disabled strategy never fires',
    !regDisabled.evaluateAll({ candles: makeCandles(risingCloses), context: disabledCtx, chainMetrics: BULLISH_METRICS })
      .some((c) => c.strategyId === 'ema_cross'));

  ok('registry lists five versioned families', registry.list().length === 5 &&
    registry.list().every((d) => d.strategyId && d.version && d.description));
}

/* -------------------------- 8. Option selector -------------------------- */

function testOptionSelector() {
  console.log('[8] Option selector (liquidity / spread / freshness filters)');

  const sel = new OptionSelector({
    strikeOffset: 0, maxSpreadPct: 3, minLegVolume: 500, minLegOi: 500,
    maxChainAgeMs: 30000, minDelta: 0.25, maxDelta: 0.8, ivMin: 8, ivMax: 60,
  });

  const base = sel.select(makeChain(), 'CE', { chainAt: Date.now(), nowFn: () => 0 });
  ok('ok case: best-ask entry', base.ok === true && base.entryPrice === 100.5 && base.strike === 25000,
    JSON.stringify(base.violations));
  ok('ok case: spread computed', base.spreadPct != null && approx(base.spreadPct, 1.0, 0.1));

  ok('empty chain', sel.select({ spot: NaN, strikes: [] }, 'CE').ok === false);

  const wide = makeChain(); wide.strikes[5].ce.top_ask_price = 110; wide.strikes[5].ce.top_bid_price = 90;
  const rWide = sel.select(wide, 'CE', { chainAt: Date.now(), nowFn: () => 0 });
  ok('wide spread rejected', rWide.ok === false && rWide.violations.some((v) => v.startsWith('SPREAD')), JSON.stringify(rWide.violations));

  const thinVol = makeChain(); thinVol.strikes[5].ce.volume = 10;
  ok('low volume rejected', sel.select(thinVol, 'CE', { chainAt: Date.now(), nowFn: () => 0 })
    .violations.some((v) => v.startsWith('LOW_VOLUME')));

  const thinOi = makeChain(); thinOi.strikes[5].ce.oi = 100;
  ok('low OI rejected', sel.select(thinOi, 'CE', { chainAt: Date.now(), nowFn: () => 0 })
    .violations.some((v) => v.startsWith('LOW_OI')));

  const hiIv = makeChain(); hiIv.strikes[5].ce.implied_volatility = 90;
  ok('IV out of band rejected', sel.select(hiIv, 'CE', { chainAt: Date.now(), nowFn: () => 0 })
    .violations.some((v) => v.startsWith('IV_')));

  const farDelta = makeChain(); farDelta.strikes[5].ce.greeks.delta = 0.95;
  ok('delta out of band rejected', sel.select(farDelta, 'CE', { chainAt: Date.now(), nowFn: () => 0 })
    .violations.some((v) => v.startsWith('DELTA_')));

  const stale = sel.select(makeChain(), 'CE', { chainAt: Date.now() - 60000, nowFn: () => Date.now() });
  ok('stale chain rejected', stale.ok === false && stale.violations.some((v) => v.startsWith('STALE_CHAIN')));

  const pe = sel.select(makeChain(), 'PE', { chainAt: Date.now(), nowFn: () => 0 });
  ok('PE leg selects put', pe.ok === true && pe.securityId === 40001, String(pe.securityId));
}

/* -------------------------- 9. Risk manager -------------------------- */

function testRiskManager() {
  console.log('[9] Risk manager (hard pre-trade gate)');

  const mk = (over = {}) => ({
    symbol: 'NIFTY', entryPrice: 100, stopTrigger: 70, targetPrice: 160,
    qty: 75, openPositions: 0, dailyPnl: 0, optionViolations: [], force: true, ...over,
  });
  const rm = () => new RiskManager({ ...RISK0 }, {
    signalWindow: { start: '09:20', end: '15:05' },
    nowFn: () => new Date('2026-11-03T05:00:00Z'),
  });

  ok('clean trade passes', rm().review(mk()).passed === true);

  ok('max positions', rm().review(mk({ openPositions: 3 })).violations.includes('MAX_POSITIONS'));
  ok('daily loss limit', rm().review(mk({ dailyPnl: -5001 })).violations.includes('DAILY_LOSS_LIMIT'));
  ok('daily loss boundary passes', rm().review(mk({ dailyPnl: -4999 })).passed === true);
  ok('max notional', rm().review(mk({ qty: 5000 })).violations.includes('MAX_NOTIONAL'));
  ok('max per-trade loss', rm().review(mk({ qty: 500 })).violations.includes('MAX_TRADE_LOSS'));
  ok('invalid stop/target', rm().review(mk({ stopTrigger: 110 })).violations.includes('INVALID_STOP_TARGET'));
  ok('option violations echoed', rm().review(mk({ optionViolations: ['SPREAD_20PCT'] }))
    .violations.includes('OPTION_SPREAD_20PCT'));

  const r3 = rm();
  r3.onTradeClosed(-100); r3.onTradeClosed(-100); r3.onTradeClosed(-100);
  ok('circuit breaker after 3 consecutive losses', r3.review(mk()).violations.includes('CIRCUIT_BREAKER'));

  const r2 = rm();
  r2.onTradeClosed(-100); r2.onTradeClosed(-100); r2.onTradeClosed(50);
  ok('win resets consecutive-loss count', r2.review(mk()).passed === true);

  const closedMarket = new RiskManager({ ...RISK0 }, {
    signalWindow: { start: '09:20', end: '15:05' },
    nowFn: () => new Date('2026-11-03T01:00:00Z'), // 06:30 IST Tuesday
  });
  const rClosed = closedMarket.review({ ...mk(), force: false });
  ok('closed session rejected', rClosed.violations.includes('SESSION_CLOSED') &&
    rClosed.violations.includes('OUTSIDE_ENTRY_WINDOW'), JSON.stringify(rClosed.violations));
}

/* -------------------------- 10. Tev1 selector -------------------------- */

function stubOllama(behavior: any = {}) {
  return {
    calls: 0,
    lastRequest: null,
    async systemOne(req) {
      this.calls++;
      this.lastRequest = req;
      if (behavior.hang) return new Promise(() => { /* never settles */ });
      if (behavior.reject) throw new Error('ollama unreachable');
      return { answers: { strategy: behavior.answer } };
    },
  };
}

async function testTev1Selector() {
  console.log('[10] Tev1 strategy selector (fail-closed, via ollama-sdk surface)');

  const candidates = [
    { strategyId: 'ema_cross', direction: 'CE', score: 0.8, description: 'EMA cross strategy.' },
    { strategyId: 'range_break', direction: 'PE', score: 0.6, description: 'Range break strategy.' },
  ];
  const policy = { model: 'tev1:0.8b', minConfidence: 0.55, timeoutMs: 3000 };
  const state = buildTev1State({
    snapshotId: 'TEST|1|2', symbol: 'NIFTY', expiry: { daysToExpiry: 2 },
    context: buildMarketContext(makeCandles(risingCloses), BULLISH_METRICS, {}),
    candidates, portfolio: { openPositions: 0, dailyPnl: 0 },
  });

  // 1. no eligible candidates -> NO_TRADE without any model call
  const stubNone = stubOllama();
  const r1 = await new Tev1StrategySelector(stubNone, policy).select({ state, candidates: [] });
  ok('no candidates -> NO_TRADE, zero model calls',
    r1.status === 'NO_TRADE' && r1.reason === 'NO_ELIGIBLE_CANDIDATES' && stubNone.calls === 0);

  // 2. one candidate -> criteria contain it plus NO_TRADE
  const stubOne = stubOllama({ answer: { type: 'choice', choice: 'ema_cross', confidence: 0.9, probabilities: {} } });
  const r2 = await new Tev1StrategySelector(stubOne, policy)
    .select({ state, candidates: candidates.slice(0, 1) });
  const criteriaKeys = Object.keys(stubOne.lastRequest.questions.strategy.criteria);
  ok('one candidate exposed + NO_TRADE', r2.status === 'SELECTED' &&
    criteriaKeys.length === 2 && criteriaKeys.includes('ema_cross') && criteriaKeys.includes('NO_TRADE'),
    JSON.stringify(criteriaKeys));

  // 3. multiple candidates -> only eligible ids are exposed
  const stubMulti = stubOllama({ answer: { type: 'choice', choice: 'ema_cross', confidence: 0.9, probabilities: {} } });
  const r3 = await new Tev1StrategySelector(stubMulti, policy).select({ state, candidates });
  const keys3 = Object.keys(stubMulti.lastRequest.questions.strategy.criteria);
  ok('only eligible strategies exposed', keys3.length === 3 && keys3.includes('NO_TRADE') &&
    keys3.includes('ema_cross') && keys3.includes('range_break'), JSON.stringify(keys3));
  ok('request carries compact state + model', stubMulti.lastRequest.model === 'tev1:0.8b' &&
    stubMulti.lastRequest.state.schemaVersion === 'options-decision-v1');

  // 4. valid selection
  ok('valid selection', r3.status === 'SELECTED' && r3.strategyId === 'ema_cross' && r3.confidence === 0.9);

  // 5. model selects NO_TRADE
  const r5 = await new Tev1StrategySelector(stubOllama({ answer: { type: 'choice', choice: 'NO_TRADE', confidence: 0.7, probabilities: {} } }), policy)
    .select({ state, candidates });
  ok('model NO_TRADE -> no entry', r5.status === 'NO_TRADE' && r5.reason === 'MODEL_SELECTED_NO_TRADE');

  // 6. model invents an unknown strategy
  const r6 = await new Tev1StrategySelector(stubOllama({ answer: { type: 'choice', choice: 'momentum_break', confidence: 0.9, probabilities: {} } }), policy)
    .select({ state, candidates });
  ok('unknown strategy -> NO_TRADE', r6.status === 'NO_TRADE' && r6.reason === 'UNKNOWN_STRATEGY_SELECTION');

  // 7. confidence below threshold
  const r7 = await new Tev1StrategySelector(stubOllama({ answer: { type: 'choice', choice: 'ema_cross', confidence: 0.3, probabilities: {} } }), policy)
    .select({ state, candidates });
  ok('low confidence -> NO_TRADE', r7.status === 'NO_TRADE' && r7.reason === 'INSUFFICIENT_MODEL_CONFIDENCE');

  // 8. malformed answers
  const r8a = await new Tev1StrategySelector(stubOllama({ answer: null }), policy).select({ state, candidates });
  const r8b = await new Tev1StrategySelector(stubOllama({ answer: { type: 'score', score: 5 } }), policy).select({ state, candidates });
  ok('malformed answer -> NO_TRADE', r8a.reason === 'INVALID_DECISION_TYPE' && r8b.reason === 'INVALID_DECISION_TYPE');

  // 9. timeout (hung transport + 60ms deadline)
  const t0 = Date.now();
  const r9 = await new Tev1StrategySelector(stubOllama({ hang: true }), { ...policy, timeoutMs: 60 })
    .select({ state, candidates });
  ok('timeout -> NO_TRADE (fail closed, fast)', r9.reason === 'DECISION_SERVICE_UNAVAILABLE' && Date.now() - t0 < 2000);

  // 10. model unavailable
  const r10 = await new Tev1StrategySelector(stubOllama({ reject: true }), policy).select({ state, candidates });
  ok('service unavailable -> NO_TRADE', r10.status === 'NO_TRADE' && r10.reason === 'DECISION_SERVICE_UNAVAILABLE');

  // 11. deterministic fallback selector
  ok('deterministic: none -> NO_TRADE', deterministicSelect([], { minScore: 0.45 }).reason === 'NO_ELIGIBLE_CANDIDATES');
  ok('deterministic: below min score', deterministicSelect([{ strategyId: 'x', score: 0.2 }], { minScore: 0.45 }).reason === 'BELOW_MIN_SCORE');
  ok('deterministic: highest score wins', deterministicSelect(candidates, { minScore: 0.45 }).strategyId === 'ema_cross');

  // 12. real SDK loads and constructs a selector (no server contact)
  const built = await createTev1Selector({ baseUrl: 'http://127.0.0.1:11434', timeoutMs: 500 }, {});
  ok('ollama-sdk loads; selector constructible', built instanceof Tev1StrategySelector);

  // 13. state contract
  ok('tev1 state shape', state.underlying.symbol === 'NIFTY' &&
    state.eligibleCandidates.length === 2 &&
    state.marketContext.regime === REGIMES.TREND_UP &&
    state.chainSummary.daysToExpiry === 2);
}

/* -------------------------- 11. Decision journal -------------------------- */

function testDecisionJournal() {
  console.log('[11] Decision journal (dedupe + audit trail)');

  const tmp = fs.mkdtempSync('/tmp/journal-');
  const journal = new DecisionJournal(tmp, { logger: null });
  const context = buildMarketContext(makeCandles(risingCloses), BULLISH_METRICS, {});
  const snap = 'NIFTY|12345|67890';

  ok('first snapshot evaluates', journal.shouldEvaluate('NIFTY', snap) === true);
  journal.markDecided('NIFTY', snap);
  ok('identical snapshot is skipped (no duplicate intents)', journal.shouldEvaluate('NIFTY', snap) === false);
  ok('new snapshot evaluates', journal.shouldEvaluate('NIFTY', 'NIFTY|12345|67999') === true);

  journal.record({ snapshotId: snap, symbol: 'NIFTY', context, eligible: ['ema_cross'],
    selector: 'deterministic', selected: 'ema_cross', confidence: 0.8, decision: 'SIGNAL', reason: 'ENTRY' });
  journal.record({ snapshotId: 'NIFTY|1|2', symbol: 'NIFTY', context,
    eligible: [], selector: 'deterministic', decision: 'NO_TRADE', reason: 'NO_ELIGIBLE_CANDIDATES' });
  journal.record({ snapshotId: 'NIFTY|1|3', symbol: 'NIFTY', context,
    eligible: ['ema_cross'], selector: 'tev1', decision: 'NO_TRADE', reason: 'RISK_REJECTED',
    violations: ['MAX_POSITIONS'] });

  const rows = readCsv(path.join(tmp, 'decisions.csv'));
  ok('decisions.csv rows', rows.length === 3, String(rows.length));
  ok('journal counts', journal.counts.total === 3 && journal.counts.signals === 1);
  ok('NO_TRADE rows are journaled', rows.some((r) => r.decision === 'NO_TRADE' && r.reason === 'NO_ELIGIBLE_CANDIDATES'));
  ok('violations journaled', rows.some((r) => r.violations === 'MAX_POSITIONS'));

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* -------------------------- 12. Paper broker -------------------------- */

function testPaperBroker() {
  console.log('[12] Paper broker (SL-M, target, trailing, time exit, charges)');

  const tmp = fs.mkdtempSync('/tmp/paper-broker-');
  const mkSignal = (secId) => ({
    at: '2026-11-03T05:00:00.000Z', symbol: 'TEST', direction: 'CE',
    strategyId: 'ema_cross', strike: 25000, expiry: '2026-11-05',
    optionSecurityId: secId, premium: 100, score: 0.8,
  });

  // --- zero-charges semantics ---
  const broker = new PaperBroker(RISK0, { statePath: path.join(tmp, 'positions.json'), logger: null });

  let p = broker.openPosition(mkSignal(42528), { lotSize: 75, lots: 1, entryPrice: 100 });
  ok('position opened', p && p.qty === 75 && p.entryPrice === 100);
  ok('sl trigger 70', p.stopTrigger === 70, String(p.stopTrigger));
  ok('target 160', p.targetPrice === 160, String(p.targetPrice));
  broker.onTick(42528, 150);
  ok('no premature exit', broker.openCount === 1);
  broker.onTick(42528, 165);
  let closed = broker.closedTrades.find((t) => t.id === p.id);
  ok('target exit', closed && closed.exitReason === 'TARGET' && closed.exitPrice === 160);
  ok('target pnl', closed && approx(closed.pnl, 60 * 75, 0.01), String(closed?.pnl));
  ok('charges zero by config', closed && closed.charges === 0);

  p = broker.openPosition(mkSignal(42529), { lotSize: 75, lots: 1, entryPrice: 100 });
  broker.onTick(42529, 65);
  const sl = broker.closedTrades.find((t) => t.id === p.id);
  ok('sl exit (gap through trigger)', sl && sl.exitReason === 'SL' && sl.exitPrice === 65);

  p = broker.openPosition(mkSignal(42530), { lotSize: 75, lots: 1, entryPrice: 100 });
  broker.onTick(42530, 130);
  ok('trail armed', p.trailActive === true);
  ok('trail trigger ratcheted', p.stopTrigger === round2v(130 * 0.85), `${p.stopTrigger}`);
  broker.onTick(42530, 140);
  ok('trail follows high', p.stopTrigger === round2v(140 * 0.85), String(p.stopTrigger));
  broker.onTick(42530, 118);
  const tr = broker.closedTrades.find((t) => t.id === p.id);
  ok('trail exit', tr && tr.exitReason === 'TRAIL_SL' && tr.pnl > 0);

  p = broker.openPosition(mkSignal(42531), { lotSize: 75, lots: 1, entryPrice: 100 });
  broker.onTick(42531, 110);
  const dupA = broker.openPosition(mkSignal(42531), { lotSize: 75, lots: 1, entryPrice: 100 });
  ok('duplicate leg rejected while open', dupA === null &&
    broker.positions.filter((x) => x.optionSecurityId === 42531 && x.status === 'OPEN').length === 1);
  broker.squareOffAll('TIME_EXIT');
  const te = broker.closedTrades.find((t) => t.id === p.id);
  ok('time exit', te && te.exitReason === 'TIME_EXIT' && te.exitPrice === 110);
  ok('all closed', broker.openCount === 0);

  const broker2 = new PaperBroker(RISK0, { statePath: path.join(tmp, 'positions.json'), logger: null });
  ok('state persisted', broker2.closedTrades.length === broker.closedTrades.length);

  fs.writeFileSync(path.join(tmp, 'stale.json'), JSON.stringify({
    positions: [{ id: 'P9001', openedAt: '2026-10-01T05:00:00.000Z', status: 'OPEN', symbol: 'TEST',
      direction: 'CE', optionTradingSymbol: 'X', optionSecurityId: 1, expiry: 'x', strike: 1,
      lotSize: 1, lots: 1, qty: 1, tickSize: 0.05, entryPrice: 100, stopTrigger: 70, initialStopTrigger: 70,
      targetPrice: 160, trailActive: false, highWater: 100, lastPrice: 105, score: 0, reason: '', events: [] }],
    nextId: 9002,
  }));
  const broker3 = new PaperBroker(RISK0, { statePath: path.join(tmp, 'stale.json'), logger: null });
  ok('stale position squared off', broker3.openCount === 0 &&
    broker3.closedTrades[0]?.exitReason === 'STALE_SQUAREOFF');

  // --- charges + slippage model ---
  const RISK_CH = { ...RISK0, charges: { brokeragePerOrder: 20, slippageTicks: 1 } };
  const bch = new PaperBroker(RISK_CH, { logger: null });
  const pch = bch.openPosition(mkSignal(42600), { lotSize: 75, lots: 1, entryPrice: 100.5, tickSize: 0.05 });
  ok('entry includes slippage', pch.entryPrice === 100.55, String(pch.entryPrice));
  ok('charges recorded on open', pch.events.some((e) => e.event === 'OPEN'));
  bch.onTick(42600, 165);
  const tch = bch.closedTrades[0];
  const expTarget = round2v(100.55 * 1.6);
  ok('target exit at limit', tch.exitReason === 'TARGET' && approx(tch.exitPrice, expTarget, 0.01), `${tch.exitPrice} vs ${expTarget}`);
  ok('pnl net of brokerage', approx(tch.pnl, (expTarget - 100.55) * 75 - 40, 0.02), String(tch.pnl));
  ok('charges field set', tch.charges === 40);

  const bch2 = new PaperBroker(RISK_CH, { logger: null });
  const psl = bch2.openPosition(mkSignal(42601), { lotSize: 75, lots: 1, entryPrice: 100, tickSize: 0.05 });
  bch2.onTick(42601, 50);
  const tsl = bch2.closedTrades[0];
  ok('sl exit worse by slippage', approx(tsl.exitPrice, Math.min(round2v(100.05 * 0.7), 50) - 0.05, 0.01), String(tsl.exitPrice));

  fs.rmSync(tmp, { recursive: true, force: true });
}

const round2v = (v) => Math.round(v * 100) / 100;

/* ------------------------ 13. CSV + instrument master ------------------------ */

const SAMPLE_MASTER = [
  'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME',
  'NSE,I,13,INDEX,0,NIFTY,1.0,Nifty 50,0001-01-01,,XX,0.0500,,INDEX,X,NIFTY',
  'BSE,I,51,INDEX,0,SENSEX,1.0,Sensex,0001-01-01,,XX,0.0100,,INDEX,X,SENSEX',
  'NSE,E,2885,EQUITY,0,RELIANCE,1.0,Reliance Industries,,,,10.0000,NA,ES,EQ,RELIANCE INDUSTRIES LTD',
  'BSE,E,500325,EQUITY,0,RELIANCE,1.0,Reliance Industries,,,,10.0000,NA,ES,EQ,RELIANCE INDUSTRIES LTD',
  'NSE,D,35008,OPTIDX,0,NIFTY-Nov2026-17350-CE,75.0,NIFTY 09 NOV 17350 CALL,2026-11-09 14:30:00,17350.00000,CE,5.0000,W,OP,,',
  'NSE,D,35009,OPTIDX,0,NIFTY-Nov2026-17350-PE,75.0,NIFTY 09 NOV 17350 PUT,2026-11-09 14:30:00,17350.00000,PE,5.0000,W,OP,,',
  'NSE,D,36008,OPTIDX,0,NIFTY-Nov2026-17400-CE,75.0,NIFTY 26 NOV 17400 CALL,2026-11-26 14:30:00,17400.00000,CE,5.0000,M,OP,,',
  'NSE,D,36009,OPTIDX,0,NIFTY-Nov2026-17400-PE,75.0,NIFTY 26 NOV 17400 PUT,2026-11-26 14:30:00,17400.00000,PE,5.0000,M,OP,,',
  'BSE,D,1100742,OPTIDX,0,SENSEX-Nov2026-70800-PE,20.0,SENSEX 26 NOV 70800 PUT,2026-11-26 15:30:00,70800.00000,PE,5.0000,M,OPTIDX,,BSXOPT',
  'NSE,D,125951,OPTSTK,0,RELIANCE-Nov2026-720-CE,500.0,RELIANCE 23 NOV 720 CALL,2026-11-23 14:30:00,720.00000,CE,5.0000,M,OP,,',
].join('\n');

function testCsvAndInstruments() {
  console.log('[13] CSV + instrument master');

  const tmp = fs.mkdtempSync('/tmp/csv-instr-');

  const f = path.join(tmp, 't.csv');
  appendCsvRow(f, { a: 1, b: 'x,y', c: 'q"q' });
  appendCsvRow(f, { a: 2, b: 'plain', c: 'z' });
  const rows = readCsv(f);
  ok('csv round trip', rows.length === 2 && rows[0].a === '1' && rows[1].b === 'plain');
  ok('csv escaping', rows[0].b === 'x,y' && rows[0].c === 'q"q');

  const master = new InstrumentMaster({ dataDir: tmp });
  master.parse(SAMPLE_MASTER, ['NIFTY', 'SENSEX', 'RELIANCE']);

  const nifty = master.resolveUnderlying({ symbol: 'NIFTY', kind: 'index' });
  ok('resolve NIFTY index', nifty.securityId === 13 && nifty.segment === 'IDX_I');
  const rel = master.resolveUnderlying({ symbol: 'RELIANCE', kind: 'stock' });
  ok('resolve RELIANCE prefers NSE', rel.securityId === 2885 && rel.segment === 'NSE_EQ');
  ok('nearest weekly expiry', master.nearestExpiry('NIFTY', 'weekly', '2026-11-03') === '2026-11-09');
  ok('nearest monthly expiry', master.nearestExpiry('NIFTY', 'monthly', '2026-11-03') === '2026-11-26');
  const leg = master.leg('NIFTY', '2026-11-09', 17350, 'CE');
  ok('leg lookup', leg && leg.securityId === 35008 && leg.segment === 'NSE_FNO' && leg.lotSize === 75);

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* -------------------------- 14. Mock end-to-end -------------------------- */

async function testEndToEnd() {
  console.log('[14] Mock end-to-end: context -> registry -> selection -> option -> risk -> paper -> report');

  const tmp = fs.mkdtempSync('/tmp/e2e-');
  const logger = new BotLogger(tmp);
  const candles = makeCandles(risingCloses);

  // Layer 1
  const metrics = { ...BULLISH_METRICS };
  const context = buildMarketContext(candles, metrics, {});
  const registry = new StrategyRegistry({
    strategies: { emaCross: { enabled: true, minSpreadPct: 0.05 } },
    chainConfirmation: { enabled: true, opposeKill: 0.2, agreeBoost: 0.15 },
  });
  const candidates = registry.evaluateAll({ candles, context, chainMetrics: metrics });
  ok('e2e candidates produced', candidates.length > 0, JSON.stringify(candidates.map((c) => c.strategyId)));

  // Layer 2 (deterministic; exits must not depend on any model)
  const selection = deterministicSelect(candidates, { minScore: 0.45 });
  ok('e2e deterministic selection', selection.status === 'SELECTED' && selection.strategyId === 'ema_cross');

  // Option construction
  const optionSelector = new OptionSelector({
    strikeOffset: 0, maxSpreadPct: 3, minLegVolume: 500, minLegOi: 500,
    maxChainAgeMs: 30000, minDelta: 0.25, maxDelta: 0.8, ivMin: 8, ivMax: 60,
  });
  const chain = makeChain();
  const option = optionSelector.select(chain, 'CE', { chainAt: Date.now(), nowFn: () => 0 });
  ok('e2e option selected', option.ok === true && option.entryPrice === 100.5);

  // Layer 3
  const riskManager = new RiskManager(RISK0, {
    signalWindow: { start: '09:20', end: '15:05' },
    nowFn: () => new Date('2026-11-03T05:00:00Z'),
  });
  const risk = riskManager.review({
    symbol: 'TEST', entryPrice: option.entryPrice,
    stopTrigger: round2v(option.entryPrice * 0.7),
    targetPrice: round2v(option.entryPrice * 1.6),
    qty: 75, openPositions: 0, dailyPnl: 0, optionViolations: option.violations, force: true,
  });
  ok('e2e risk approved', risk.passed === true, JSON.stringify(risk.violations));

  // Paper execution + journal + CSV wiring (same as scan mode)
  const journal = new DecisionJournal(tmp, { logger });
  const broker = new PaperBroker(RISK0, { statePath: path.join(tmp, 'positions.json'), logger });
  broker.on('exit', (t) => {
    logger.logTrade({
      id: t.id, openedAt: t.openedAt, closedAt: t.closedAt || '', symbol: t.symbol,
      strategyId: t.strategyId || '', direction: t.direction, optionTradingSymbol: t.optionTradingSymbol,
      optionSecurityId: t.optionSecurityId, expiry: t.expiry, strike: t.strike,
      qty: t.qty, entryPrice: t.entryPrice, exitPrice: t.exitPrice,
      exitReason: t.exitReason, charges: t.charges ?? '', pnl: t.pnl, score: t.score,
    });
    riskManager.onTradeClosed(t.pnl);
  });

  const candidate = candidates.find((c) => c.strategyId === selection.strategyId);
  const signal = {
    ...candidate, symbol: 'TEST', strike: option.strike, expiry: chain.expiry,
    optionSecurityId: option.securityId, premium: option.leg.last_price,
    signalId: 'S-1', reason: 'e2e',
  };
  const pos = broker.openPosition(signal, {
    lotSize: 75, lots: 1, tradingSymbol: 'TEST-25000-CE', legSegment: 'NSE_FNO', entryPrice: option.entryPrice,
  });
  ok('e2e paper entry', pos && pos.qty === 75 && pos.entryPrice === 100.5);
  logger.logSignal({
    at: new Date().toISOString(), signalId: 'S-1', symbol: 'TEST', strategyId: candidate.strategyId,
    selector: 'deterministic', confidence: candidate.score, direction: 'CE', score: candidate.score,
    spot: context.spot, regime: context.regime, strike: option.strike, expiry: chain.expiry,
    optionSecurityId: option.securityId, premium: option.leg.last_price, iv: option.iv,
    spreadPct: option.spreadPct, reason: 'e2e',
  });
  journal.record({ snapshotId: 'TEST|1|1', symbol: 'TEST', context, eligible: candidates.map((c) => c.strategyId),
    selector: 'deterministic', selected: candidate.strategyId, confidence: candidate.score,
    decision: 'SIGNAL', reason: 'ENTRY' });

  // Live ticks through the real binary parser drive the exit - no model involved.
  const feed = new FeedClient({ clientId: 'x', accessToken: 'y', logger });
  feed.on('tick', (t) => broker.onTick(t.securityId, t.ltp));
  const sendTick = (ltp) => {
    const payload = Buffer.alloc(42);
    payload.writeFloatLE(ltp, 0);
    payload.writeInt16LE(75, 4);
    payload.writeInt32LE(1730610060, 6);
    payload.writeFloatLE(ltp, 10);
    payload.writeInt32LE(1000, 14);
    payload.writeInt32LE(150, 18);
    payload.writeInt32LE(150, 22);
    payload.writeFloatLE(ltp - 5, 26);
    payload.writeFloatLE(ltp - 8, 30);
    payload.writeFloatLE(ltp + 2, 34);
    payload.writeFloatLE(ltp - 6, 38);
    feed.handleFrame(buildPacket(4, 2, option.securityId, payload));
  };
  sendTick(120);
  ok('e2e position still open', broker.openCount === 1);
  sendTick(165); // target 160.8
  const trade = broker.closedTrades[0];
  ok('e2e target exit via feed ticks', trade && trade.exitReason === 'TARGET' && trade.exitPrice === 160.8,
    `${trade?.exitReason} ${trade?.exitPrice}`);
  ok('e2e pnl', trade && approx(trade.pnl, (160.8 - 100.5) * 75, 0.01), String(trade?.pnl));

  // Duplicate snapshot cannot re-decide
  journal.markDecided('TEST', 'TEST|1|1');
  ok('e2e duplicate snapshot blocked', journal.shouldEvaluate('TEST', 'TEST|1|1') === false);

  const trades = readCsv(path.join(tmp, 'trades.csv'));
  const signals = readCsv(path.join(tmp, 'signals.csv'));
  const decisions = readCsv(path.join(tmp, 'decisions.csv'));
  ok('e2e trades.csv (with strategyId)', trades.length === 1 && trades[0].strategyId === 'ema_cross');
  ok('e2e signals.csv', signals.length === 1 && signals[0].strategyId === 'ema_cross');
  ok('e2e decisions.csv', decisions.length === 1 && decisions[0].decision === 'SIGNAL');

  const { file, text } = generateDailyReport(istParts().date, { dataDir: tmp });
  ok('e2e report exists', fs.existsSync(file));
  ok('e2e report has trade + strategy', /TARGET/.test(text) && /ema_cross/.test(text));
  ok('e2e report disclaims paper', /no real orders/i.test(text));

  fs.rmSync(tmp, { recursive: true, force: true });
}
