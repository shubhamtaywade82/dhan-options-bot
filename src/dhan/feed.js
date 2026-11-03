/**
 * DhanHQ v2 Live Market Feed (WebSocket) + binary packet parser.
 *
 * Connection (docs - Live Market Feed):
 *   wss://api-feed.dhan.co?version=2&token=<JWT>&clientId=<id>&authType=2
 *
 * Subscribe requests are JSON text:
 *   { "RequestCode": 15|17|21, "InstrumentCount": N,
 *     "InstrumentList": [{ "ExchangeSegment": "NSE_FNO", "SecurityId": "49081" }] }
 *   15 = ticker packets (LTP+LTT), 17 = quote packets, 21 = full packets w/ depth
 *   Up to 100 instruments per message, 5000 per connection.
 *
 * Responses are binary, LITTLE ENDIAN, and start with an 8-byte header:
 *   [0]      feed response code (byte)
 *   [1..2]   message length (int16 LE)
 *   [3]      exchange segment (byte)
 *   [4..7]   security id (int32 LE)
 *
 * Packet layouts documented for DhanHQ v2 (current codes) with legacy code
 * aliases accepted as well - both generations are disjoint so mapping both
 * is unambiguous:
 *   code 2 | 15 -> ticker   : f32 LTP, i32 LTT                       (16 bytes)
 *   code 6 | 16 -> prevclose: f32 prev close, i32 prev OI            (16 bytes)
 *   code 4 | 17 -> quote    : f32 LTP, i16 LTQ, i32 LTT, f32 ATP,
 *                            i32 volume, i32 sellQty, i32 buyQty,
 *                            f32 open, f32 close, f32 high, f32 low  (50 bytes)
 *   code 5       -> oi      : i32 open interest                       (12 bytes)
 *   code 8 | 21 -> full     : quote fields + OI, OI high/low + 5x20B depth (162 bytes)
 *   code 50      -> disconnect: i16 reason                            (10 bytes)
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const FEED_URL = 'wss://api-feed.dhan.co';
const FEED_VERSION = '2';
const AUTH_TYPE = '2';

const SEGMENT_BY_CODE = {
  0: 'IDX_I', 1: 'NSE_EQ', 2: 'NSE_FNO', 3: 'NSE_CURRENCY',
  4: 'BSE_EQ', 5: 'MCX_COMM', 7: 'BSE_CURRENCY', 8: 'BSE_FNO',
};
const CODE_BY_SEGMENT = Object.fromEntries(
  Object.entries(SEGMENT_BY_CODE).map(([k, v]) => [v, parseInt(k, 10)])
);

export const FEED_REQUEST = {
  CONNECT: 11, DISCONNECT: 12,
  SUBSCRIBE_TICKER: 15, UNSUBSCRIBE_TICKER: 16,
  SUBSCRIBE_QUOTE: 17, UNSUBSCRIBE_QUOTE: 18,
  SUBSCRIBE_FULL: 21, UNSUBSCRIBE_FULL: 22,
};

const PACKET_TYPE_BY_CODE = {
  2: 'ticker', 15: 'ticker',
  6: 'prevclose', 16: 'prevclose',
  4: 'quote', 17: 'quote',
  5: 'oi',
  8: 'full', 21: 'full',
  50: 'disconnect',
};

const PACKET_LENGTH = { ticker: 16, prevclose: 16, quote: 50, oi: 12, full: 162, disconnect: 10 };

/**
 * Parse one binary packet (Buffer, little endian).
 * Pure function - unit tested in test/selftest.js.
 */
export function parseBinaryPacket(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8) return { type: 'invalid', reason: `short header (${buf.length}B)` };

  const code = buf[0];
  const messageLength = buf.readInt16LE(1);
  const segmentByte = buf[3];

  // Security id is documented little-endian; verify plausibility and fall
  // back to big-endian once just in case (defensive, cheap).
  let securityId = buf.readInt32LE(4);
  if (!(securityId > 0 && securityId < 100_000_000)) {
    const be = buf.readInt32BE(4);
    if (be > 0 && be < 100_000_000) securityId = be;
  }

  const type = PACKET_TYPE_BY_CODE[code] || 'unknown';
  const segment = SEGMENT_BY_CODE[segmentByte] || `SEG_${segmentByte}`;

  const packet = { type, code, segment, securityId, messageLength };

  switch (type) {
    case 'ticker':
      packet.ltp = round2(buf.readFloatLE(8));
      packet.lastTradeTime = buf.readInt32LE(12);
      break;
    case 'prevclose':
      packet.prevClose = round2(buf.readFloatLE(8));
      packet.prevOi = buf.readInt32LE(12);
      break;
    case 'oi':
      packet.oi = buf.readInt32LE(8);
      break;
    case 'quote':
    case 'full':
      packet.ltp = round2(buf.readFloatLE(8));
      packet.lastTradeQty = buf.readInt16LE(12);
      packet.lastTradeTime = buf.readInt32LE(14);
      packet.averagePrice = round2(buf.readFloatLE(18));
      packet.volume = buf.readInt32LE(22);
      packet.sellQty = buf.readInt32LE(26);
      packet.buyQty = buf.readInt32LE(30);
      if (type === 'full') {
        packet.oi = buf.readInt32LE(34);
        packet.oiDayHigh = buf.readInt32LE(38);
        packet.oiDayLow = buf.readInt32LE(42);
        packet.open = round2(buf.readFloatLE(46));
        packet.close = round2(buf.readFloatLE(50));
        packet.high = round2(buf.readFloatLE(54));
        packet.low = round2(buf.readFloatLE(58));
      } else {
        packet.open = round2(buf.readFloatLE(34));
        packet.close = round2(buf.readFloatLE(38));
        packet.high = round2(buf.readFloatLE(42));
        packet.low = round2(buf.readFloatLE(46));
      }
      break;
    case 'disconnect':
      packet.reason = buf.readInt16LE(8);
      break;
    default:
      return packet; // unknown code; caller skips messageLength bytes
  }

  const expected = PACKET_LENGTH[type];
  if (expected && messageLength > 0 && messageLength !== expected && messageLength !== expected - 8) {
    packet.lengthMismatch = { messageLength, expected };
  }
  return packet;
}

/** Split one binary frame into a list of parsed packets (frames may concatenate packets). */
export function parseBinaryFrame(buf) {
  const packets = [];
  let offset = 0;
  let guard = 0;
  while (offset + 8 <= buf.length && guard++ < 200) {
    const slice = buf.subarray(offset);
    const p = parseBinaryPacket(slice);
    const expected = PACKET_LENGTH[p.type];
    let advance;
    if (expected && slice.length >= expected) {
      advance = expected;
    } else if (p.messageLength > 0 && offset + 8 + p.messageLength <= buf.length) {
      advance = 8 + p.messageLength;
    } else {
      advance = slice.length; // cannot frame further
    }
    packets.push(p);
    offset += advance;
  }
  return packets;
}

const round2 = (v) => Math.round(v * 100) / 100;

export class FeedClient extends EventEmitter {
  constructor({ clientId, accessToken, logger = null, WebSocketImpl = WebSocket } = {}) {
    super();
    this.clientId = clientId;
    this.accessToken = accessToken;
    this.logger = logger;
    this.WebSocketImpl = WebSocketImpl;
    this.ws = null;
    this.subscribed = new Map();  // `${segment}:${securityId}` -> { segment, securityId }
    this.ltpCache = new Map();    // key -> { ltp, at, ...quoteFields }
    this.backoffMs = 1000;
    this.closedByUser = false;
    this.lastMessageAt = 0;
    this._watchdog = null;
    this._reportedUnknown = new Set();
  }

  get connected() { return this.ws?.readyState === this.WebSocketImpl.OPEN; }

  connect() {
    this.closedByUser = false;
    const url = `${FEED_URL}?version=${FEED_VERSION}&token=${encodeURIComponent(this.accessToken)}` +
                `&clientId=${encodeURIComponent(this.clientId)}&authType=${AUTH_TYPE}`;
    const ws = new this.WebSocketImpl(url);
    this.ws = ws;

    ws.on('open', () => {
      this.logger?.info('Market feed connected.');
      this.backoffMs = 1000;
      this.lastMessageAt = Date.now();
      this._startWatchdog();
      this.emit('status', 'open');
      // Re-subscribe everything after a reconnect.
      if (this.subscribed.size > 0) this._sendSubscriptions([...this.subscribed.values()]);
    });

    ws.on('message', (data) => this.handleFrame(data));

    ws.on('close', (code, reason) => {
      this._stopWatchdog();
      this.emit('status', 'closed', { code, reason: String(reason) });
      if (!this.closedByUser) this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.logger?.warn(`Market feed error: ${err.message}`);
      // 'close' always follows 'error' in ws - reconnect handled there.
    });
  }

  /** Public for unit tests: process one binary frame. */
  handleFrame(data) {
    this.lastMessageAt = Date.now();
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let packets;
    try {
      packets = parseBinaryFrame(buf);
    } catch (err) {
      this.logger?.warn(`Feed parse error: ${err.message}`);
      return;
    }
    for (const p of packets) this._dispatch(p);
  }

  _dispatch(p) {
    if (p.type === 'unknown') {
      if (!this._reportedUnknown.has(p.code)) {
        this._reportedUnknown.add(p.code);
        this.logger?.warn(`Feed: unknown packet code ${p.code} (${p.messageLength}B payload)`);
      }
      return;
    }
    if (p.type === 'disconnect') {
      this.logger?.warn(`Feed disconnect packet, reason code ${p.reason}`);
      this.emit('status', 'disconnected', { reason: p.reason });
      return;
    }
    if (p.type === 'invalid') return;

    const key = `${p.segment}:${p.securityId}`;
    if (p.type === 'ticker' || p.type === 'quote' || p.type === 'full') {
      const prev = this.ltpCache.get(key) || {};
      this.ltpCache.set(key, { ...prev, ...p, at: Date.now() });
      this.emit('tick', p);
    } else if (p.type === 'prevclose') {
      const prev = this.ltpCache.get(key) || {};
      this.ltpCache.set(key, { ...prev, prevClose: p.prevClose, prevOi: p.prevOi });
      this.emit('prevclose', p);
    } else if (p.type === 'oi') {
      const prev = this.ltpCache.get(key) || {};
      this.ltpCache.set(key, { ...prev, oi: p.oi });
      this.emit('oi', p);
    }
  }

  subscribe(instruments, mode = FEED_REQUEST.SUBSCRIBE_QUOTE) {
    for (const i of instruments) {
      this.subscribed.set(`${i.segment}:${i.securityId}`, { segment: i.segment, securityId: i.securityId });
    }
    if (this.connected) this._sendSubscriptions(instruments, mode);
  }

  unsubscribe(instruments, mode = FEED_REQUEST.UNSUBSCRIBE_QUOTE) {
    for (const i of instruments) this.subscribed.delete(`${i.segment}:${i.securityId}`);
    if (!this.connected) return;
    for (let i = 0; i < instruments.length; i += 100) {
      const chunk = instruments.slice(i, i + 100);
      this._sendJson({
        RequestCode: mode,
        InstrumentCount: chunk.length,
        InstrumentList: chunk.map((i) => ({ ExchangeSegment: i.segment, SecurityId: String(i.securityId) })),
      });
    }
  }

  _sendSubscriptions(instruments, mode = FEED_REQUEST.SUBSCRIBE_QUOTE) {
    for (let i = 0; i < instruments.length; i += 100) {
      const chunk = instruments.slice(i, i + 100);
      this._sendJson({
        RequestCode: mode,
        InstrumentCount: chunk.length,
        InstrumentList: chunk.map((i) => ({ ExchangeSegment: i.segment, SecurityId: String(i.securityId) })),
      });
    }
  }

  _sendJson(obj) {
    if (!this.connected) return;
    try { this.ws.send(JSON.stringify(obj)); } catch (err) { this.logger?.warn(`Feed send failed: ${err.message}`); }
  }

  /** Latest LTP for an instrument, or null when older than maxAgeMs. */
  getLtp(segment, securityId, maxAgeMs = 30000) {
    const e = this.ltpCache.get(`${segment}:${securityId}`);
    if (!e || (maxAgeMs > 0 && Date.now() - e.at > maxAgeMs)) return null;
    return e.ltp;
  }

  getSnapshot(segment, securityId, maxAgeMs = 30000) {
    const e = this.ltpCache.get(`${segment}:${securityId}`);
    if (!e || (maxAgeMs > 0 && Date.now() - e.at > maxAgeMs)) return null;
    return e;
  }

  _scheduleReconnect() {
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    this.logger?.warn(`Market feed closed - reconnecting in ${wait}ms...`);
    setTimeout(() => { if (!this.closedByUser) this.connect(); }, wait);
  }

  _startWatchdog() {
    this._stopWatchdog();
    this._watchdog = setInterval(() => {
      // Server pings every 10s; 45s of silence means the socket is stale.
      if (Date.now() - this.lastMessageAt > 45000) {
        this.logger?.warn('Market feed silent for 45s - forcing reconnect.');
        try { this.ws?.terminate(); } catch { /* already dead */ }
      }
    }, 15000);
  }

  _stopWatchdog() {
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
  }

  close() {
    this.closedByUser = true;
    this._stopWatchdog();
    this._sendJson({ RequestCode: FEED_REQUEST.DISCONNECT });
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

export { CODE_BY_SEGMENT };
