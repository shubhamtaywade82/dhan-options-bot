/**
 * `report` mode - regenerate the daily paper-trading report from CSVs.
 * Usage: npm run report -- [YYYY-MM-DD]
 */

import { loadConfig } from '../config.js';
import { BotLogger } from '../logger.js';
import { TelegramNotifier } from '../notify/telegram.js';
import { generateDailyReport } from '../report.js';
import { istParts } from '../ist.js';

export async function runReport(dateArg, { cfgOverride = null } = {}) {
  const cfg = cfgOverride || loadConfig();
  const logger = new BotLogger(cfg.dataDir);
  const telegram = new TelegramNotifier({ ...cfg.telegram, logger });

  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateArg || '') ? dateArg : istParts().date;
  const { file, text } = generateDailyReport(date, { dataDir: cfg.dataDir, telegram, logger });
  console.log(text);
  console.log(`\nReport file: ${file}`);
}
