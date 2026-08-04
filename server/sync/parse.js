import ExcelJS from 'exceljs';

/**
 * Tabular parsing only — no knowledge of what the columns mean. Whatever the
 * eventual source is (uploaded .csv/.xlsx today, Sheets API tomorrow), it hands
 * the rest of the pipeline the same `{ headers, rows }` shape.
 */

/* ---------------------------- CSV ---------------------------- */

/** RFC4180-ish: handles quoted fields, escaped quotes, and CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const src = text.replace(/^﻿/, ''); // strip BOM

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

/* ---------------------------- XLSX ---------------------------- */

/** exceljs cells can be rich text, hyperlinks, formulas, or dates. Flatten them. */
function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('text' in v) return v.text;
    if ('result' in v) return cellValue(v.result);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('hyperlink' in v) return v.text || v.hyperlink;
    return '';
  }
  return v;
}

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    // row.values is 1-indexed with a leading hole.
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    const cells = values.map(cellValue);
    if (cells.some((c) => c !== '' && c !== null && c !== undefined)) rows.push(cells);
  });
  return rows;
}

/* ---------------------------- Entry point ---------------------------- */

function headerKey(h) {
  return String(h ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

/**
 * @returns {Promise<{headers: string[], rows: Array<Record<string, any>>}>}
 *   Each row is keyed by normalized header AND by column index, so a template
 *   with slightly different header spelling can still be positionally mapped.
 */
export async function parseTabular(buffer, filename = '') {
  const ext = filename.toLowerCase().split('.').pop();
  let matrix;
  if (ext === 'xlsx' || ext === 'xlsm') {
    matrix = await parseXlsx(buffer);
  } else {
    matrix = parseCsv(buffer.toString('utf8'));
  }
  if (!matrix.length) return { headers: [], rows: [] };

  const headers = matrix[0].map((h) => String(cellValue(h) ?? '').trim());
  const rows = matrix.slice(1).map((cells, idx) => {
    const obj = { __row: idx + 2, __cells: cells };
    headers.forEach((h, i) => {
      obj[headerKey(h)] = cells[i] ?? '';
    });
    return obj;
  });
  return { headers, rows };
}

/** Pick the first present column from a list of accepted header spellings. */
export function pick(row, aliases) {
  for (const a of aliases) {
    const k = headerKey(a);
    if (k in row && row[k] !== '' && row[k] !== null && row[k] !== undefined) return row[k];
  }
  return '';
}

export { headerKey };
