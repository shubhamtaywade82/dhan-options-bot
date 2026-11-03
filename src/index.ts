/**
 * DhanHQ v2 Options Bot - CLI entrypoint.
 *
 * Modes:
 *   scan       live signal scanner + paper trader (default)
 *   chain      one-shot option chain snapshot:      npm run chain -- NIFTY
 *   backtest   historical sanity check:             npm run backtest -- --days 30
 *   report     regenerate the daily paper report:   npm run report -- YYYY-MM-DD
 *   selftest   offline unit tests + mock run (no credentials needed)
 *
 * Flags:
 *   --force    (scan) run outside market hours / ignore holiday calendar
 *   --once     (scan) evaluate one cycle and exit (useful on cron)
 *   --days N   (backtest)
 *
 * PAPER TRADING ONLY - this bot never places real orders.
 */

import { runScan } from './modes/scan.js';
import { runChain } from './modes/chain.js';
import { runBacktest } from './modes/backtest.js';
import { runReport } from './modes/report.js';
import { runSelftest } from '../test/selftest.js';

const [mode = 'scan', ...rest] = process.argv.slice(2);

const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));
const flagValue = (name) => {
  const hit = rest.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : (flags.has(`--${name}`) ? args[0] : undefined);
};

try {
  switch (mode) {
    case 'scan':
      await runScan({ force: flags.has('--force'), once: flags.has('--once') });
      break;
    case 'chain':
      await runChain(args[0] || 'NIFTY');
      break;
    case 'backtest': {
      const days = parseInt(flagValue('days') || '0', 10);
      await runBacktest({ days: Number.isFinite(days) && days > 0 ? days : null });
      break;
    }
    case 'report':
      await runReport(args[0]);
      break;
    case 'selftest':
      await runSelftest();
      break;
    case 'help':
    case '--help':
    case '-h':
    default:
      printHelp(mode !== 'scan' && process.argv.length > 2 ? mode : null);
      process.exit(mode === 'scan' && process.argv.length <= 2 ? 0 : 1);
  }
} catch (err) {
  console.error(`\n[ERROR] ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}

function printHelp(unknown) {
  if (unknown) console.log(`Unknown mode: ${unknown}\n`);
  console.log(`DhanHQ v2 Options Bot (paper trading only)

Usage:
  npm start                              live scanner + paper trader
  npm run scan -- --force                run even outside market hours
  npm run scan -- --once                 evaluate one cycle and exit
  npm run chain -- [SYMBOL]              option chain snapshot (default NIFTY)
  npm run backtest -- [--days N]         historical sanity check (default 30 days)
  npm run report -- [DATE]               regenerate daily paper report
  npm run selftest                       offline tests - no credentials needed

Setup: cp .env.example .env  (fill DHAN_CLIENT_ID + DHAN_ACCESS_TOKEN)`);
}
