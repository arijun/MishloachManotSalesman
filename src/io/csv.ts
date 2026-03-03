import type { Stop } from '../types.ts';

const NAME_COLS  = ['name', 'recipient', 'family'];
const ADDR_COLS  = ['address', 'addr', 'location', 'street'];
const PHONE_COLS = ['phone', 'phone number', 'cell', 'mobile', 'tel'];
const NOTES_COLS = ['notes', 'note', 'instructions', 'comment', 'comments'];

function findCol(headers: string[], candidates: string[]): number {
  return headers.findIndex(h => candidates.includes(h.trim().toLowerCase()));
}

/** Minimal RFC 4180-compliant parser for CSV and TSV. */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let col = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') { col += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { col += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === delimiter) { row.push(col); col = ''; }
      else if (ch === '\n' || (ch === '\r' && next === '\n')) {
        if (ch === '\r') i++;
        row.push(col); col = '';
        if (row.some(c => c.trim() !== '')) rows.push(row);
        row = [];
      } else { col += ch; }
    }
  }
  // last row
  row.push(col);
  if (row.some(c => c.trim() !== '')) rows.push(row);

  return rows;
}

function parseCSV(text: string): string[][] {
  const firstLine = text.slice(0, text.indexOf('\n') + 1 || text.length);
  const tabs   = (firstLine.match(/\t/g)  || []).length;
  const commas = (firstLine.match(/,/g)   || []).length;
  const delim  = tabs > commas ? '\t' : ',';
  return parseDelimited(text, delim);
}

export interface CSVParseResult {
  stops: Omit<Stop, 'id' | 'normalizedAddress' | 'coords' | 'status'>[];
  warnings: string[];
}

export function parseCSVText(text: string): CSVParseResult {
  const rows = parseCSV(text);
  if (rows.length < 2) {
    throw new Error('CSV must have a header row and at least one data row.');
  }

  const headers = rows[0].map(h => h.trim());
  const nameIdx  = findCol(headers, NAME_COLS);
  const addrIdx  = findCol(headers, ADDR_COLS);
  const phoneIdx = findCol(headers, PHONE_COLS);
  const notesIdx = findCol(headers, NOTES_COLS);

  if (nameIdx === -1) throw new Error('Could not find a "Name" column in your CSV.');
  if (addrIdx === -1) throw new Error('Could not find an "Address" column in your CSV.');

  const warnings: string[] = [];
  const stops: CSVParseResult['stops'] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const get = (idx: number) => (idx >= 0 && idx < row.length ? row[idx].trim() : '');

    const name = get(nameIdx);
    const address = get(addrIdx);
    if (!name && !address) continue; // blank row

    if (!name)    warnings.push(`Row ${i + 1}: missing name.`);
    if (!address) warnings.push(`Row ${i + 1} (${name}): missing address — row skipped.`);
    if (!address) continue;

    stops.push({
      name:        name || '(unnamed)',
      rawAddress:  address,
      phone:       get(phoneIdx),
      notes:       get(notesIdx),
    });
  }

  return { stops, warnings };
}
