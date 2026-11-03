/**
 * Technical indicators used by the market context engine and the strategy
 * registry (pure functions, unit tested).
 */

/** Exponential moving average over a price series. Returns array aligned with input. */
export function ema(values, period) {
  if (!Number.isFinite(period) || period < 1) throw new Error('ema period must be >= 1');
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/** Wilder-smoothed RSI. Returns array aligned with input (first values are approximations). */
export function rsi(closes, period = 14) {
  const n = closes.length;
  if (n < 2) return new Array(n).fill(50);
  const out = new Array(n).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < n; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);
    if (i <= period) {
      avgGain += (gain - avgGain) / i;
      avgLoss += (loss - avgLoss) / i;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out[i] = avgLoss === 0 && avgGain === 0 ? 50 : 100 - 100 / (1 + rs);
  }
  return out;
}

/** True-range ATR (Wilder smoothing). Returns array; values are in price units. */
export function atr(candles, period = 14) {
  const n = candles.length;
  if (n === 0) return [];
  const out = new Array(n).fill(0);
  let prevClose = candles[0].close;
  let value = candles[0].high - candles[0].low;
  out[0] = value;
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    value = (value * (period - 1) + tr) / period;
    out[i] = value;
    prevClose = c.close;
  }
  return out;
}

/** Average Directional Index (Wilder). Returns {adx[], plusDI[], minusDI[]}. */
export function adx(candles, period = 14) {
  const n = candles.length;
  const zeros = { adx: new Array(n).fill(0), plusDI: new Array(n).fill(0), minusDI: new Array(n).fill(0) };
  if (n < 3) return zeros;
  const trArr = atr(candles, period);
  let plusDM = 0, minusDM = 0, tr = trArr[1];
  const plusDI = zeros.plusDI, minusDI = zeros.minusDI, adxOut = zeros.adx;
  let dxSum = 0, dxCount = 0, adxValue = 0;
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    const pDM = up > down && up > 0 ? up : 0;
    const mDM = down > up && down > 0 ? down : 0;
    if (i <= period) {
      plusDM += (pDM - plusDM) / i;
      minusDM += (mDM - minusDM) / i;
      if (i > 1) tr = trArr[i];
    } else {
      plusDM = (plusDM * (period - 1) + pDM) / period;
      minusDM = (minusDM * (period - 1) + mDM) / period;
      tr = trArr[i];
    }
    const pdi = tr === 0 ? 0 : (100 * plusDM) / tr;
    const mdi = tr === 0 ? 0 : (100 * minusDM) / tr;
    plusDI[i] = pdi;
    minusDI[i] = mdi;
    const dx = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
    if (dxCount < period) {
      dxSum += dx; dxCount++;
      if (dxCount === period) adxValue = dxSum / period;
    } else {
      adxValue = (adxValue * (period - 1) + dx) / period;
    }
    adxOut[i] = adxValue;
  }
  return zeros;
}

/** Session VWAP over candles (volume-weighted; falls back to mean typical price when volume is 0). */
export function vwap(candles) {
  let pv = 0, vol = 0, tpSum = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    if (c.volume > 0) { pv += tp * c.volume; vol += c.volume; }
    tpSum += tp;
  }
  if (vol > 0) return pv / vol;
  return candles.length ? tpSum / candles.length : 0;
}

/**
 * EMA trend module score in [-1, +1].
 *   +1 : fast EMA clearly above slow EMA (>= 0.15% spread) with price leading
 *   -1 : mirrored for a down-trend
 *   ~0 : EMAs entangled (no trend worth trading)
 * Slope of the fast EMA adds confirmation and grades the strength.
 */
export function emaTrendScore(closes, { fast = 9, slow = 21 } = {}) {
  if (closes.length < slow + 2) return 0;
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const i = closes.length - 1;
  const last = closes[i];

  const spreadAt = (j) => ((f[j] - s[j]) / s[j]) * 100;
  // Average over the last 3 bars: single-bar EMA crossings on noisy data
  // must not flip the trend reading.
  const spreadPct = (spreadAt(i) + spreadAt(i - 1) + spreadAt(i - 2)) / 3;
  const slopePct = ((f[i] - f[i - 2]) / f[i - 2]) * 100;    // fast EMA direction

  const strength = Math.min(1, Math.abs(spreadPct) / 0.15); // 0.15% spread = full strength
  if (strength === 0) return 0;
  const dir = Math.sign(spreadPct);

  const priceLeading = dir > 0 ? last >= f[i] : last <= f[i];
  let score = dir * strength * (priceLeading ? 1 : 0.6);

  const slopeDir = slopePct > 0.02 ? 1 : slopePct < -0.02 ? -1 : 0;
  if (slopeDir !== 0) {
    score *= (slopeDir === dir) ? 1.25 : 0.5;  // confirm or weaken
  }
  return Math.max(-1, Math.min(1, score));
}

/** Build N-minute OHLC candles from 1-minute candles (used when only 1m data is available). */
export function resample(candles, targetMinutes) {
  if (targetMinutes === 1 || candles.length === 0) return candles;
  const bucketMs = targetMinutes * 60 * 1000;
  const out = [];
  let cur = null;
  for (const c of candles) {
    const bucketTs = Math.floor(c.ts / bucketMs) * bucketMs;
    if (!cur || cur.ts !== bucketTs) {
      if (cur) out.push(cur);
      cur = { ts: bucketTs, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, oi: c.oi };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}
