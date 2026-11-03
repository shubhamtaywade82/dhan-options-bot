/**
 * Central logger: console + rotating file + CSV trade/signal books.
 * Everything the bot does is observable from data/ afterwards.
 */

import fs from 'node:fs';
import path from 'node:path';
import { appendCsvRow } from './csv.js';
import { istStamp } from './ist.js';

export class BotLogger {
  constructor(dataDir) {
    this.dir = dataDir;
    this.logDir = path.join(dataDir, 'logs');
    fs.mkdirSync(this.logDir, { recursive: true });
    this.tradesCsv = path.join(dataDir, 'trades.csv');
    this.signalsCsv = path.join(dataDir, 'signals.csv');
    this.logFile = path.join(this.logDir, 'bot.log');
  }

  _file(line) {
    try {
      fs.appendFileSync(this.logFile, line + '\n', 'utf8');
    } catch { /* logging must never crash the bot */ }
  }

  info(msg, obj) { this._write('INFO ', msg, obj); }
  warn(msg, obj) { this._write('WARN ', msg, obj); }
  error(msg, obj) { this._write('ERROR', msg, obj); }
  signal(msg, obj) { this._write('SIGNAL', msg, obj); }

  _write(level, msg, obj) {
    const line = `[${istStamp()}] [${level}] ${msg}` + (obj !== undefined ? ' ' + safeJson(obj) : '');
    // eslint-disable-next-line no-console
    console.log(line);
    this._file(line);
  }

  logSignal(row) { appendCsvRow(this.signalsCsv, row); }

  logTrade(row) { appendCsvRow(this.tradesCsv, row); }
}

function safeJson(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}
