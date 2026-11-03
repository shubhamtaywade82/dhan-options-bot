/**
 * Daily report generator: aggregates paper trades + signals + decisions into a
 * text report (written to data/reports/report-YYYY-MM-DD.txt, pushed to Telegram).
 */

import fs from 'node:fs';
import path from 'node:path';
import { readCsv } from './csv.js';

/**
 * @param {string} dateStr  YYYY-MM-DD
 * @param {object} opts { dataDir, telegram, logger, journal? }
 */
export function generateDailyReport(dateStr, { dataDir, telegram = null, logger = null, journal = null }: any = {}) {
  const trades = readCsv(path.join(dataDir, 'trades.csv')).filter((t) => String(t.closedAt || t.openedAt).startsWith(dateStr));
  const signals = readCsv(path.join(dataDir, 'signals.csv')).filter((s) => String(s.at).startsWith(dateStr));
  const decisions = readCsv(path.join(dataDir, 'decisions.csv')).filter((d) => String(d.ts).startsWith(dateStr));

  const lines = [];
  lines.push(`========================================`);
  lines.push(` Dhan Options Bot - Paper Trading Report`);
  lines.push(` ${dateStr}`);
  lines.push(`========================================`);
  lines.push('');

  // --- decisions -------------------------------------------------------------
  if (decisions.length > 0) {
    const noTrade = decisions.filter((d) => d.decision === 'NO_TRADE');
    const signalsD = decisions.filter((d) => d.decision === 'SIGNAL');
    lines.push(`Decisions journaled : ${decisions.length}`);
    lines.push(`  signals           : ${signalsD.length}`);
    lines.push(`  no-trade          : ${noTrade.length}`);
    const reasons: Record<string, number> = {};
    for (const d of noTrade) reasons[d.reason || '?'] = (reasons[d.reason || '?'] || 0) + 1;
    const topReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (topReasons.length) lines.push(`  top no-trade      : ${topReasons.map(([k, v]) => `${k}=${v}`).join(', ')}`);
    lines.push('');
  }

  // --- signals -------------------------------------------------------------
  lines.push(`Signals generated : ${signals.length}`);
  const byStrategy: Record<string, number> = {};
  for (const s of signals) byStrategy[s.strategyId || '?'] = (byStrategy[s.strategyId || '?'] || 0) + 1;
  if (Object.keys(byStrategy).length) {
    lines.push(`  by strategy      : ${Object.entries(byStrategy).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  lines.push('');

  // --- trades --------------------------------------------------------------
  if (trades.length === 0) {
    lines.push('No paper trades today.');
  } else {
    const num = (t, k) => parseFloat(t[k] || 0);
    const total = trades.reduce((a, t) => a + num(t, 'pnl'), 0);
    const wins = trades.filter((t) => num(t, 'pnl') > 0);
    const losses = trades.filter((t) => num(t, 'pnl') < 0);
    const grossWin = wins.reduce((a, t) => a + num(t, 'pnl'), 0);
    const grossLoss = losses.reduce((a, t) => a + num(t, 'pnl'), 0);
    const charges = trades.reduce((a, t) => a + num(t, 'charges'), 0);
    const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;

    lines.push(`Paper trades      : ${trades.length}`);
    lines.push(`Wins / Losses     : ${wins.length} / ${losses.length}  (win rate ${winRate.toFixed(1)}%)`);
    lines.push(`Gross profit      : ${grossWin >= 0 ? '+' : ''}INR ${grossWin.toFixed(2)}`);
    lines.push(`Gross loss        : INR ${grossLoss.toFixed(2)}`);
    lines.push(`Charges modelled  : INR ${charges.toFixed(2)}`);
    lines.push(`Net P&L (paper)   : ${total >= 0 ? '+' : ''}INR ${total.toFixed(2)}`);
    lines.push('');

    const reasons: Record<string, number> = {};
    for (const t of trades) reasons[t.exitReason || '?'] = (reasons[t.exitReason || '?'] || 0) + 1;
    lines.push(`Exit reasons      : ${Object.entries(reasons).map(([k, v]) => `${k}=${v}`).join(', ')}`);

    const perSym: Record<string, { n: number; pnl: number }> = {};
    for (const t of trades) {
      perSym[t.symbol] ??= { n: 0, pnl: 0 };
      perSym[t.symbol].n += 1;
      perSym[t.symbol].pnl += num(t, 'pnl');
    }
    lines.push('');
    lines.push('Per underlying:');
    for (const [sym, st] of Object.entries(perSym)) {
      lines.push(`  ${sym.padEnd(12)} trades ${String(st.n).padStart(2)}  P&L ${st.pnl >= 0 ? '+' : ''}${st.pnl.toFixed(2)}`);
    }

    lines.push('');
    lines.push('Trades:');
    lines.push('  id     underlying  strategy            option                     qty    entry   exit    reason      P&L');
    lines.push('  ' + '-'.repeat(120));
    for (const t of trades) {
      lines.push('  ' + [
        String(t.id).padEnd(6),
        String(t.symbol).padEnd(10),
        String(t.strategyId || '-').padEnd(18),
        String(t.optionTradingSymbol).padEnd(26),
        String(t.qty).padStart(5),
        String(t.entryPrice).padStart(6),
        String(t.exitPrice ?? '-').padStart(7),
        String(t.exitReason || '-').padEnd(10),
        (num(t, 'pnl') >= 0 ? '+' : '') + String(num(t, 'pnl').toFixed(2)).padStart(8),
      ].join(' '));
    }
  }

  lines.push('');
  lines.push('NOTE: paper-trading simulation with modelled charges - no real orders were placed.');

  const text = lines.join('\n');

  const reportDir = path.join(dataDir, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const file = path.join(reportDir, `report-${dateStr}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  logger?.info(`Daily report written to ${file}`);
  telegram?.send(`\`\`\`\n${text}\n\`\`\``);
  return { file, text };
}
