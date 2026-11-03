/**
 * `chain` mode - one-shot option chain snapshot (sanity check / debugging).
 * Usage: node src/index.js chain NIFTY
 */

import { loadConfig, assertCredentials } from '../config.js';
import { BotLogger } from '../logger.js';
import { DhanClient } from '../dhan/client.js';
import { InstrumentMaster } from '../dhan/instruments.js';
import { MarketData } from '../dhan/marketData.js';
import { computeChainMetrics } from '../strategy/chainAnalytics.js';
import { istStamp } from '../ist.js';

export async function runChain(symbolArg, { cfgOverride = null } = {}) {
  const cfg = cfgOverride || loadConfig();
  assertCredentials(cfg);

  const logger = new BotLogger(cfg.dataDir);
  const client = new DhanClient({ clientId: cfg.clientId, accessToken: cfg.accessToken, logger });
  const marketData = new MarketData(client, logger);
  const master = new InstrumentMaster({ dataDir: cfg.dataDir, logger });
  await master.load(cfg.instruments.map((i) => i.symbol));

  const entry = cfg.instruments.find((i) => i.symbol === symbolArg) || { symbol: symbolArg, kind: 'index', expiryPreference: 'weekly' };
  const underlying = master.resolveUnderlying(entry);
  const expiry = master.nearestExpiry(entry.symbol, entry.expiryPreference)
    || (await marketData.expiryList(underlying))[0];
  if (!expiry) throw new Error(`No expiry found for ${entry.symbol}`);

  const chain = await marketData.optionChain(underlying, expiry);
  const m = computeChainMetrics(chain, { atmWindow: 2 });

  console.log(`\n${entry.symbol} option chain - expiry ${expiry} - spot ${m.spot} - ${istStamp()}`);
  console.log(`ATM ${m.atmStrike} | PCR ${m.pcr?.toFixed(2) ?? 'n/a'} | ATM IV ${m.atmIv?.toFixed(1) ?? 'n/a'} | strikes ${m.strikeCount}`);
  console.log('');

  const idx = chain.strikes.findIndex((s) => s.strike === m.atmStrike);
  const from = Math.max(0, idx - 5), to = Math.min(chain.strikes.length - 1, idx + 5);
  const row = (label, get) => String(get ?? '-').padStart(10);
  console.log(['strike'.padStart(10), 'CE OI'.padStart(10), 'CE chg'.padStart(10), 'CE IV'.padStart(10),
    'CE LTP'.padStart(10), 'PE LTP'.padStart(10), 'PE IV'.padStart(10), 'PE chg'.padStart(10), 'PE OI'.padStart(10)].join(' | '));
  console.log('-'.repeat(104));
  for (let i = from; i <= to; i++) {
    const s = chain.strikes[i];
    const ceChg = s.ce ? s.ce.oi - (s.ce.previous_oi || 0) : null;
    const peChg = s.pe ? s.pe.oi - (s.pe.previous_oi || 0) : null;
    const mark = s.strike === m.atmStrike ? ' <= ATM' : '';
    console.log([
      String(s.strike).padStart(10),
      row('x', s.ce?.oi),
      row('x', ceChg),
      row('x', s.ce?.implied_volatility?.toFixed(1)),
      row('x', s.ce?.last_price),
      row('x', s.pe?.last_price),
      row('x', s.pe?.implied_volatility?.toFixed(1)),
      row('x', peChg),
      row('x', s.pe?.oi),
    ].join(' | ') + mark);
  }
  console.log('');
  console.log(`greeks ATM CE: ${JSON.stringify(m.atmLegs.ce?.greeks || {})} delta=${m.atmLegs.ce?.greeks?.delta ?? '-'}`);
  console.log(`greeks ATM PE: ${JSON.stringify(m.atmLegs.pe?.greeks || {})} delta=${m.atmLegs.pe?.greeks?.delta ?? '-'}`);
}
