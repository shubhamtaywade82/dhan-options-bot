/**
 * DhanHQ instrument master: download, cache and lookup.
 *
 * Source CSV (refreshed daily by Dhan):
 *   https://images.dhan.co/api-data/api-scrip-master.csv
 * Columns used:
 *   SEM_EXM_EXCH_ID  NSE | BSE | MCX
 *   SEM_SEGMENT      I=index, E=equity, D=derivatives, C=currency, M=commodity
 *   SEM_SMST_SECURITY_ID  exchange-standard security id (used in ALL API calls)
 *   SEM_INSTRUMENT_NAME   INDEX | EQUITY | OPTIDX | OPTSTK | FUTIDX | ...
 *   SEM_TRADING_SYMBOL    e.g. NIFTY-Nov2026-17350-CE / RELIANCE / SENSEX
 *   SEM_LOT_UNITS         lot size
 *   SEM_EXPIRY_DATE       2026-11-09 14:30:00
 *   SEM_STRIKE_PRICE / SEM_OPTION_TYPE (CE|PE)
 *   SEM_EXPIRY_FLAG       W weekly | M monthly
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from '../csv.js';
import { istParts } from '../ist.js';

export const MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';

// CSV (EXCH_ID, segment letter) -> DhanHQ API exchange-segment enum
function apiSegment(exch, segLetter) {
  switch (`${exch}|${segLetter}`) {
    case 'NSE|I': return 'IDX_I';
    case 'NSE|E': return 'NSE_EQ';
    case 'NSE|D': return 'NSE_FNO';
    case 'NSE|C': return 'NSE_CURRENCY';
    case 'BSE|I': return 'IDX_I';
    case 'BSE|E': return 'BSE_EQ';
    case 'BSE|D': return 'BSE_FNO';
    case 'BSE|C': return 'BSE_CURRENCY';
    case 'MCX|D': return 'MCX_COMM';
    default: return null;
  }
}

export class InstrumentMaster {
  constructor({ dataDir, logger = null, fetchImpl = null } = {}) {
    this.dataDir = dataDir;
    this.cachePath = path.join(dataDir, 'instruments.csv');
    this.metaPath = path.join(dataDir, 'instruments.meta.json');
    this.logger = logger;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.underlyings = new Map();   // symbol -> { securityId, segment, exchange, instrument, lotSize }
    this.optionLegs = new Map();    // symbol -> Map(expiry -> Map('strike|CE' -> leg))
    this.loadedForDate = null;
  }

  /**
   * Load (and refresh when stale) the scrip master for the given watchlist symbols.
   * `symbols` limits which option rows are kept in memory (the file has ~200k rows).
   */
  async load(symbols, { force = false } = {}) {
    const today = istParts().date;
    if (!force && this.loadedForDate === today) return;

    const fresh = await this.ensureFreshFile(today, force);
    const text = fs.readFileSync(this.cachePath, 'utf8');
    this.parse(text, symbols);
    this.loadedForDate = today;
    this.logger?.info(`Instrument master loaded (${fresh ? 'downloaded' : 'cached'}): ` +
      `${this.underlyings.size} underlyings, option legs for ${[...this.optionLegs.keys()].join(', ') || 'none'}`);
  }

  async ensureFreshFile(today, force) {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8')); } catch { /* no cache yet */ }
    const exists = fs.existsSync(this.cachePath);
    if (exists && !force && meta.date === today) return false;

    this.logger?.info('Downloading Dhan instrument master...');
    const res = await this.fetchImpl(MASTER_URL);
    if (!res.ok) throw new Error(`Instrument master download failed: HTTP ${res.status}`);
    const body = await res.text();
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.cachePath, body, 'utf8');
    fs.writeFileSync(this.metaPath, JSON.stringify({ date: today, url: MASTER_URL }), 'utf8');
    return true;
  }

  parse(text, watchSymbols) {
    this.underlyings = new Map();
    this.optionLegs = new Map();
    const prefixes = new Map(watchSymbols.map((s) => [`${s}-`, s]));
    const rows = parseCsv(text);

    for (const r of rows) {
      const exch = r.SEM_EXM_EXCH_ID;
      const seg = apiSegment(exch, r.SEM_SEGMENT);
      if (!seg) continue;
      const secId = r.SEM_SMST_SECURITY_ID;
      const instrument = r.SEM_INSTRUMENT_NAME;
      const sym = r.SEM_TRADING_SYMBOL;

      if (instrument === 'INDEX' || instrument === 'EQUITY') {
        if (instrument === 'EQUITY' && r.SEM_SERIES && r.SEM_SERIES !== 'EQ') continue;
        // Prefer NSE when a symbol is listed on both exchanges.
        const prev = this.underlyings.get(sym);
        if (!prev || (prev.exchange !== 'NSE' && exch === 'NSE')) {
          this.underlyings.set(sym, {
            symbol: sym,
            securityId: parseInt(secId, 10),
            segment: seg,
            exchange: exch,
            instrument,
            lotSize: parseFloat(r.SEM_LOT_UNITS) || null,
          });
        }
        continue;
      }

      if (instrument !== 'OPTIDX' && instrument !== 'OPTSTK') continue;
      // Option rows: keep only legs of the watched underlyings.
      let base = null;
      for (const [prefix, symbol] of prefixes) {
        if (sym.startsWith(prefix)) { base = symbol; break; }
      }
      if (!base) continue;

      const expiry = (r.SEM_EXPIRY_DATE || '').slice(0, 10);
      const strike = parseFloat(r.SEM_STRIKE_PRICE);
      const optionType = r.SEM_OPTION_TYPE;
      if (!expiry || !Number.isFinite(strike) || (optionType !== 'CE' && optionType !== 'PE')) continue;

      if (!this.optionLegs.has(base)) this.optionLegs.set(base, new Map());
      const byExpiry = this.optionLegs.get(base);
      if (!byExpiry.has(expiry)) byExpiry.set(expiry, new Map());
      byExpiry.get(expiry).set(`${strike}|${optionType}`, {
        securityId: parseInt(secId, 10),
        tradingSymbol: sym,
        strike,
        optionType,
        expiry,
        expiryFlag: r.SEM_EXPIRY_FLAG,
        lotSize: parseFloat(r.SEM_LOT_UNITS) || null,
        segment: seg,          // NSE_FNO / BSE_FNO
        instrument,
        tickSize: parseFloat(r.SEM_TICK_SIZE) || 0.05,
      });
    }
  }

  /** Resolve a configured instrument entry into API-ready descriptors. */
  resolveUnderlying({ symbol, kind }) {
    const u = this.underlyings.get(symbol);
    if (!u) throw new Error(`Symbol ${symbol} not found in instrument master`);
    if (kind === 'index' && u.instrument !== 'INDEX') throw new Error(`${symbol} is not an index`);
    if (kind === 'stock' && u.instrument !== 'EQUITY') throw new Error(`${symbol} is not a stock`);
    return u;
  }

  /** Segment string expected by the Option Chain API for the underlying. */
  static chainSegmentFor(u) {
    return u.segment === 'IDX_I' ? 'IDX_I' : 'NSE_EQ';
  }

  expiries(symbol) {
    const byExpiry = this.optionLegs.get(symbol);
    if (!byExpiry) return [];
    return [...byExpiry.keys()].sort();
  }

  /**
   * Nearest tradable expiry (IST today onwards).
   * preference: 'weekly' prefers W-flag expiries, 'monthly' prefers M-flag,
   * anything else = plain nearest. Always falls back to the nearest expiry.
   */
  nearestExpiry(symbol, preference = 'weekly', todayStr = null) {
    const today = todayStr || istParts().date;
    const byExpiry = this.optionLegs.get(symbol);
    if (!byExpiry || byExpiry.size === 0) return null;
    const all = [...byExpiry.entries()]
      .map(([expiry, legs]) => ({
        expiry,
        weekly: [...legs.values()].some((l) => l.expiryFlag === 'W'),
        monthly: [...legs.values()].some((l) => l.expiryFlag === 'M'),
      }))
      .filter((e) => e.expiry >= today)
      .sort((a, b) => a.expiry.localeCompare(b.expiry));
    if (all.length === 0) return null;
    if (preference === 'weekly') {
      const weekly = all.find((e) => e.weekly);
      if (weekly) return weekly.expiry;
    } else if (preference === 'monthly') {
      const monthly = all.find((e) => e.monthly && !e.weekly);
      if (monthly) return monthly.expiry;
    }
    return all[0].expiry;
  }

  leg(symbol, expiry, strike, optionType) {
    return this.optionLegs.get(symbol)?.get(expiry)?.get(`${strike}|${optionType}`) || null;
  }

  /** Lot size for the option series of an underlying (all strikes share it). */
  lotSizeFor(symbol, expiry) {
    const byExpiry = this.optionLegs.get(symbol);
    if (byExpiry) {
      const legs = byExpiry.get(expiry);
      if (legs && legs.size > 0) {
        const first = legs.values().next().value;
        if (first.lotSize) return first.lotSize;
      }
    }
    const u = this.underlyings.get(symbol);
    return u?.lotSize || null;
  }
}
