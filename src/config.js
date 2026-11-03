/**
 * Loads .env + config.json, validates, and exposes a single settings object.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(ROOT, '.env') });

export function loadConfig(overrides = {}) {
  const file = path.join(ROOT, 'config.json');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));

  const cfg = {
    rootDir: ROOT,
    dataDir: overrides.dataDir || path.join(ROOT, 'data'),
    clientId: overrides.clientId || process.env.DHAN_CLIENT_ID || '',
    accessToken: overrides.accessToken || process.env.DHAN_ACCESS_TOKEN || '',
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.TELEGRAM_CHAT_ID || '',
      enabled: disk.telegram?.enabled !== false,
    },
    ...disk,
  };

  validate(cfg);
  return cfg;
}

function fail(msg) { throw new Error(`config: ${msg}`); }

function validate(cfg) {
  if (!Array.isArray(cfg.instruments) || cfg.instruments.length === 0) fail('instruments list is empty');
  for (const i of cfg.instruments) {
    if (!i.symbol) fail('every instrument needs a symbol');
    if (i.kind !== 'index' && i.kind !== 'stock') fail(`${i.symbol}: kind must be "index" or "stock"`);
    if (!Number.isFinite(i.lots) || i.lots < 1) fail(`${i.symbol}: lots must be >= 1`);
  }
  for (const k of ['stopLossPct', 'targetPct', 'squareOffTime']) {
    if (cfg.risk?.[k] === undefined) fail(`risk.${k} missing`);
  }
  if (cfg.risk.stopLossPct <= 0 || cfg.risk.targetPct <= 0) fail('risk percentages must be > 0');
  if (!cfg.decision?.signalWindow?.start || !cfg.decision?.signalWindow?.end) fail('decision.signalWindow missing');
  const selector = cfg.decision?.selector;
  if (selector && !['auto', 'deterministic', 'tev1'].includes(selector)) {
    fail(`decision.selector must be auto|deterministic|tev1 (got ${selector})`);
  }
}

export function assertCredentials(cfg) {
  if (!cfg.clientId || !cfg.accessToken) {
    throw new Error(
      'Missing DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN. Copy .env.example to .env and fill them in ' +
      '(token is generated at web.dhan.co > My Profile > DhanHQ APIs and is valid for 24 hours).'
    );
  }
}
