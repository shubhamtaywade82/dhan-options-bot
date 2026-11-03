/**
 * CandleAggregator: merges REST intraday candles with live WebSocket ticks.
 *
 * The REST /charts/intraday snapshot is authoritative for completed candles;
 * the forming candle is built tick-by-tick from the websocket so the context
 * engine always sees the freshest data without hammering the REST API.
 */

export class CandleAggregator {
  /**
   * @param {number} intervalMinutes candle bucket size (default 5)
   */
  constructor(intervalMinutes = 5) {
    this.intervalMs = intervalMinutes * 60 * 1000;
    this.bucketMs = intervalMinutes * 60 * 1000;
    this.intervalMinutes = intervalMinutes;
    this.forming = null; // { ts, open, high, low, close, volume, oi, tickCount }
  }

  /** Feed one underlying tick: { ts(ms epoch), price, volume? } */
  onTick(ts, price, volume = 0) {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(ts)) return;
    const bucket = Math.floor(ts / this.bucketMs) * this.bucketMs;
    if (!this.forming || this.forming.ts !== bucket) {
      this.forming = { ts: bucket, open: price, high: price, low: price, close: price, volume, oi: 0, tickCount: 1 };
    } else {
      this.forming.high = Math.max(this.forming.high, price);
      this.forming.low = Math.min(this.forming.low, price);
      this.forming.close = price;
      this.forming.volume += volume;
      this.forming.tickCount += 1;
    }
  }

  /**
   * Merge REST candles with the forming tick candle.
   * Rule: REST wins for any bucket it already covers; the tick candle is
   * appended only when it is NEWER than the newest REST candle.
   * @returns {Array} candles sorted by ts
   */
  merge(restCandles) {
    const out = [...(restCandles || [])].sort((a, b) => a.ts - b.ts);
    if (!this.forming) return out;
    const newest = out.length ? out[out.length - 1].ts : 0;
    if (this.forming.ts > newest) {
      out.push({ ...this.forming });
    } else if (this.forming.ts === newest) {
      // Same bucket: prefer REST (it has exchange OHLCV) but refresh the close
      // with the latest tick when the tick is newer information.
      out[out.length - 1] = { ...out[out.length - 1], close: this.forming.close };
    }
    return out;
  }

  reset() { this.forming = null; }
}
