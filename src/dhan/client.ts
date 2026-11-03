/**
 * Rate-limited DhanHQ v2 REST client (axios).
 *
 * Rate limits enforced (docs: https://docs.dhanhq.co/api/v2/ - Rate Limits):
 *   - quotes  (/marketfeed/*)          : 1 request / second        (unlimited per minute)
 *   - data    (/charts/*)              : 5 requests / second, 100k / day
 *   - chain   (/optionchain*)          : the same parameter-set may only be requested
 *                                        once every ~3 seconds; unique requests are faster.
 *
 * NOTE: This client intentionally exposes ONLY data endpoints.
 * There is no order-placement method anywhere in this bot - it is a
 * signal scanner + paper trader and never trades real money.
 */

import axios from 'axios';

const BASE_URL = 'https://api.dhan.co/v2';

/** Serialize calls with a minimum spacing (ms) per named bucket. */
class SpacingLimiter {
  spacingMs: number;
  chain: Promise<any>;
  lastAt: number;

  constructor(spacingMs) {
    this.spacingMs = spacingMs;
    this.chain = Promise.resolve();
    this.lastAt = 0;
  }
  schedule(fn) {
    const run = async () => {
      const wait = this.lastAt + this.spacingMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastAt = Date.now();
      return fn();
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }
}

const BUCKETS = {
  quote: new SpacingLimiter(1100), // 1 rps
  data: new SpacingLimiter(250),   // ~4 rps, safely under 5
  chain: new SpacingLimiter(350),  // global floor between unique chain calls
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DhanClient {
  clientId: string;
  logger: any;
  http: any;
  _chainKeyLast: Map<string, number>;
  _chainKeySpacingMs: number;
  requestCount: number;

  /**
   * @param {object} opts
   * @param {string} opts.clientId
   * @param {string} opts.accessToken
   * @param {import('./logger.js').BotLogger} [opts.logger]
   */
  constructor({ clientId, accessToken, logger = null, axiosImpl = axios }: any = {}) {
    if (!clientId || !accessToken) {
      throw new Error('DhanClient needs clientId and accessToken');
    }
    this.clientId = clientId;
    this.logger = logger;
    this.http = axiosImpl.create({
      baseURL: BASE_URL,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'access-token': accessToken,
        'client-id': clientId,
      },
    });
    // Same-parameter-set spacing for the option chain API (>= 3s).
    this._chainKeyLast = new Map();
    this._chainKeySpacingMs = 3100;
    this.requestCount = 0;
  }

  async post(path, body, { bucket = 'data', chainKey = null, retries = 2 } = {}) {
    const attempt = async (triesLeft) => {
      const res = await BUCKETS[bucket].schedule(async () => {
        if (bucket === 'chain' && chainKey) await this._respectChainKeySpacing(chainKey);
        this.requestCount++;
        return this.http.post(path, body);
      });
      return res.data;
    };

    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
      try {
        return await attempt(i);
      } catch (err) {
        lastErr = err;
        const status = err.response?.status;
        const apiMsg = err.response?.data?.errorMessage || err.response?.data?.errorType || '';
        // Retry only on transient conditions.
        if (status === 429 || status === 500 || status === 502 || status === 503 || !err.response) {
          if (i < retries) {
            const backoff = 1200 * (i + 1);
            this.logger?.warn(`DhanHQ ${path} -> ${status || 'network error'} ${apiMsg}; retrying in ${backoff}ms`);
            await sleep(backoff);
            continue;
          }
        }
        if (status && status >= 400) {
          throw new DhanApiError(status, apiMsg || err.message, path, err.response?.data);
        }
        throw err;
      }
    }
    throw lastErr;
  }

  async _respectChainKeySpacing(key) {
    const last = this._chainKeyLast.get(key) || 0;
    const wait = last + this._chainKeySpacingMs - Date.now();
    if (wait > 0) await sleep(wait);
    this._chainKeyLast.set(key, Date.now());
  }

  /* ------------------------- Data endpoints (safe, read-only) ------------------------- */

  /** POST /marketfeed/ltp  - body like { NSE_FNO: [49081], IDX_I: [13] } */
  ltp(securitiesBySegment) {
    return this.post('/marketfeed/ltp', securitiesBySegment, { bucket: 'quote' });
  }

  /** POST /marketfeed/ohlc */
  ohlc(securitiesBySegment) {
    return this.post('/marketfeed/ohlc', securitiesBySegment, { bucket: 'quote' });
  }

  /** POST /marketfeed/quote - full depth snapshot */
  quote(securitiesBySegment) {
    return this.post('/marketfeed/quote', securitiesBySegment, { bucket: 'quote' });
  }

  /** POST /optionchain/expirylist - body { UnderlyingScrip, UnderlyingSeg } */
  expiryList(underlyingScrip, underlyingSeg) {
    return this.post('/optionchain/expirylist',
      { UnderlyingScrip: underlyingScrip, UnderlyingSeg: underlyingSeg },
      { bucket: 'chain', chainKey: `exp:${underlyingScrip}` });
  }

  /** POST /optionchain - body { UnderlyingScrip, UnderlyingSeg, Expiry } */
  optionChain(underlyingScrip, underlyingSeg, expiry) {
    return this.post('/optionchain',
      { UnderlyingScrip: underlyingScrip, UnderlyingSeg: underlyingSeg, Expiry: expiry },
      { bucket: 'chain', chainKey: `oc:${underlyingScrip}:${expiry}` });
  }

  /** POST /charts/intraday - minute candles (interval 1/5/15/25/60) */
  intraday({ securityId, exchangeSegment, instrument, interval, fromDate, toDate, oi = false }) {
    return this.post('/charts/intraday',
      { securityId: String(securityId), exchangeSegment, instrument, interval: String(interval), oi, fromDate, toDate },
      { bucket: 'data' });
  }

  /** POST /charts/historical - daily candles */
  historical({ securityId, exchangeSegment, instrument, expiryCode = 0, oi = false, fromDate, toDate }) {
    return this.post('/charts/historical',
      { securityId: String(securityId), exchangeSegment, instrument, expiryCode, oi, fromDate, toDate },
      { bucket: 'data' });
  }

  /**
   * POST /charts/rollingoption - expired/historical options data at a strike relative to spot
   * (ATM ... ATM+10/ATM-10 for index near expiry; ATM+3/ATM-3 otherwise).
   */
  rollingOption({ securityId, exchangeSegment, instrument, expiryCode, expiryFlag, interval, strike, drvOptionType, requiredData, fromDate, toDate }) {
    return this.post('/charts/rollingoption',
      { securityId: String(securityId), exchangeSegment, instrument, expiryCode, expiryFlag, interval: String(interval), strike, drvOptionType, requiredData, fromDate, toDate },
      { bucket: 'data' });
  }
}

export class DhanApiError extends Error {
  status: number;
  path: string;
  payload: any;

  constructor(status, message, path, payload) {
    super(`DhanHQ ${status} on ${path}: ${message}`);
    this.name = 'DhanApiError';
    this.status = status;
    this.path = path;
    this.payload = payload;
  }
}
