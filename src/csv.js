/**
 * Tiny CSV helpers (no external dependency).
 * parseCsv implements RFC-4180-style quoting so escaped values round-trip.
 */

import fs from 'node:fs';

/**
 * Parse CSV text into an array of objects keyed by the header row.
 * Handles quoted cells, doubled quotes and CRLF line endings.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false, started = false;

  const pushCell = () => { row.push(cell.trim()); cell = ''; };
  const pushRow = () => {
    pushCell();
    if (row.some((c) => c !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true; started = true;
    } else if (ch === ',') {
      pushCell(); started = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (started || cell !== '') pushRow();
      cell = ''; started = false;
    } else {
      cell += ch; started = true;
    }
  }
  if (started || cell !== '') pushRow();

  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ''])));
}

/** Append a row (object) to a CSV file, writing the header when the file is new. */
export function appendCsvRow(filePath, row) {
  const headers = Object.keys(row);
  const values = headers.map((h) => row[h] ?? '');
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  let out = '';
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    out += headers.map(esc).join(',') + '\n';
  }
  out += values.map(esc).join(',') + '\n';
  fs.appendFileSync(filePath, out, 'utf8');
}

/** Read a CSV file into rows (objects). Returns [] when missing. */
export function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return parseCsv(fs.readFileSync(filePath, 'utf8'));
}
