/**
 * High-level market data helpers over DhanClient.
 * Returns plain, normalized objects so the rest of the bot never touches raw API shapes.
 */

import { InstrumentMaster } from './instruments.js';

export class MarketData {
  client: any;
  logger: any;

  constructor(client, logger = null) {
    this.client = client;
    this.logger = logger;
  }

  /**
   * Batched LTP snapshot.
   * @param {Array<{segment:string, securityId:number}>} instruments
   * @returns {Map<string, number>} key `${segment}:${securityId}` -> ltp
   */
  async ltpBatch(instruments) {
    if (instruments.length === 0) return new Map();
    const body = {};
    for (const i of instruments) {
      (body[i.segment] ??= []).push(i.securityId);
    }
    const res = await this.client.ltp(body);
    const out = new Map();
    const data = res?.data || {};
    for (const [segment, byId] of Object.entries(data)) {
      for (const [secId, q] of Object.entries(byId)) {
        if (q && Number.isFinite(q.last_price)) out.set(`${segment}:${secId}`, q.last_price);
      }
    }
    return out;
  }

  /**
   * Full option chain for an underlying + expiry.
   * @returns {{ spot:number, expiry:string, strikes:Array<{strike:number, ce:object|null, pe:object|null}> }}
   */
  async optionChain(underlying, expiry) {
    const res = await this.client.optionChain(
      underlying.securityId,
      InstrumentMaster.chainSegmentFor(underlying),
      expiry,
    );
    const data: any = res?.data;
    if (!data || !data.oc) throw new Error(`Option chain response missing data.oc for ${underlying.symbol}`);
    const strikes = Object.entries(data.oc as Record<string, any>)
      .map(([strikeStr, legs]) => ({
        strike: parseFloat(strikeStr),
        ce: legs.ce || null,
        pe: legs.pe || null,
      }))
      .filter((s) => Number.isFinite(s.strike))
      .sort((a, b) => a.strike - b.strike);
    return { spot: data.last_price, expiry, strikes };
  }

  /** Expiry list for an underlying (array of YYYY-MM-DD strings). */
  async expiryList(underlying) {
    const res = await this.client.expiryList(
      underlying.securityId,
      InstrumentMaster.chainSegmentFor(underlying),
    );
    return res?.data || [];
  }

  /**
   * Intraday minute candles for an underlying.
   * @returns {Array<{ts:number, open:number, high:number, low:number, close:number, volume:number, oi:number}>}
   */
  async intradayCandles(underlying, interval, fromDate, toDate) {
    const res = await this.client.intraday({
      securityId: underlying.securityId,
      exchangeSegment: underlying.segment,     // IDX_I for indices, NSE_EQ for stocks
      instrument: underlying.instrument,       // INDEX / EQUITY
      interval,
      fromDate,
      toDate,
    });
    return zipCandles(res);
  }

  /**
   * Historical rolling-option data (expired options) - used by the backtest.
   * Returns { call: Candle[], put: Candle[] } aligned per timestamp.
   */
  async rollingOption({ underlying, interval, expiryCode = 0, expiryFlag = 'WEEK', strike = 'ATM', fromDate, toDate }) {
    const requiredData = ['open', 'high', 'low', 'close', 'iv', 'oi', 'spot'];
    const fetchType = async (drvOptionType) => {
      const res: any = await this.client.rollingOption({
        securityId: underlying.securityId,
        exchangeSegment: InstrumentMaster.chainSegmentFor(underlying) === 'IDX_I' ? 'IDX_I' : 'NSE_EQ',
        instrument: underlying.instrument === 'INDEX' ? 'INDEX' : 'EQUITY',
        expiryCode,
        expiryFlag,
        interval,
        strike,
        drvOptionType,
        requiredData,
        fromDate,
        toDate,
      });
      return res?.data || null;
    };
    const [ce, pe] = await Promise.all([fetchType('CALL'), fetchType('PUT')]);
    return { call: ce, put: pe };
  }
}

function zipCandles(res) {
  if (!res || !Array.isArray(res.timestamp)) return [];
  const n = res.timestamp.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      ts: res.timestamp[i],
      open: res.open?.[i] ?? 0,
      high: res.high?.[i] ?? 0,
      low: res.low?.[i] ?? 0,
      close: res.close?.[i] ?? 0,
      volume: res.volume?.[i] ?? 0,
      oi: res.open_interest?.[i] ?? 0,
    });
  }
  return out;
}
