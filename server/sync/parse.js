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

function sheetMatrix(ws) {
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    // row.values is 1-indexed with a leading hole.
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    const cells = values.map(cellValue);
    if (cells.some((c) => c !== '' && c !== null && c !== undefined)) rows.push(cells);
  });
  return rows;
}

/** @returns {Promise<Array<{name: string, matrix: any[][]}>>} every sheet, in workbook order. */
async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (err) {
    // exceljs reconciles comments, tables and drawings before it hands over any
    // cells, and it does that against the part layout Excel itself writes. A
    // workbook saved by another tool can be perfectly valid and still fail here
    // — openpyxl writes absolute relationship targets and puts comments under
    // `xl/comments/`, and both make exceljs dereference undefined. What reaches
    // the admin otherwise is a raw internal TypeError with no suggestion of
    // what to do about it, on the one screen where the next action matters.
    throw new Error(
      `this workbook is not in a layout the reader can open (${err.message}). ` +
        'Open it in Excel or Google Sheets, re-save it as .xlsx or .csv, and upload that.'
    );
  }
  return wb.worksheets.map((ws) => ({ name: ws.name, matrix: sheetMatrix(ws) }));
}

/* ---------------------------- Entry point ---------------------------- */

function headerKey(h) {
  return String(h ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

/** First row is the header; every later row is keyed by normalized header. */
function tabulate(matrix, sheetName = null) {
  if (!matrix.length) return { headers: [], rows: [], sheetName };

  const headers = matrix[0].map((h) => String(cellValue(h) ?? '').trim());
  const rows = matrix.slice(1).map((cells, idx) => {
    const obj = { __row: idx + 2, __cells: cells, __sheet: sheetName };
    headers.forEach((h, i) => {
      obj[headerKey(h)] = cells[i] ?? '';
    });
    return obj;
  });
  return { headers, rows, sheetName };
}

/** Sheet names compare case- and space-insensitively; "Slot Times" vs "slot times". */
const sheetKey = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Read a workbook (or CSV) as one table.
 *
 * ⚠️ `prefer` is what makes the real template readable. Before it, this took
 * `worksheets[0]`, which in a one-tab export is the right sheet and in the
 * event's own workbook is the **Instructions** tab — 158 rows of prose, every
 * one of which fails validation. The named sheet is chosen when it exists and
 * the first sheet is still the fallback, so a single-tab CSV export or last
 * year's spreadsheets read exactly as they did.
 *
 * @param {string[]} [opts.prefer] sheet names to look for, best first
 * @returns {Promise<{headers: string[], rows: Array<Record<string, any>>, sheetName: string|null}>}
 */
export async function parseTabular(buffer, filename = '', opts = {}) {
  const sheets = await parseSheets(buffer, filename);
  if (!sheets.length) return { headers: [], rows: [], sheetName: null };

  for (const want of opts.prefer || []) {
    const hit = sheets.find((s) => sheetKey(s.name) === sheetKey(want));
    if (hit) return tabulate(hit.matrix, hit.name);
  }
  return tabulate(sheets[0].matrix, sheets[0].name);
}

/**
 * Every sheet whose name is in `names`, in the order asked for. A CSV has no
 * sheet names, so it comes back as the one unnamed table — which is what makes
 * "People + Roster" and "a roster CSV" the same call at the other end.
 *
 * @returns {Promise<Array<{headers, rows, sheetName}>>} empty if none matched
 */
export async function parseNamedSheets(buffer, filename = '', names = []) {
  const sheets = await parseSheets(buffer, filename);
  if (!sheets.length) return [];
  if (sheets.length === 1 && sheets[0].name === null) {
    return [tabulate(sheets[0].matrix, null)];
  }
  const out = [];
  for (const want of names) {
    const hit = sheets.find((s) => sheetKey(s.name) === sheetKey(want));
    if (hit) out.push(tabulate(hit.matrix, hit.name));
  }
  return out;
}

/** @returns {Promise<Array<{name: string|null, matrix: any[][]}>>} */
async function parseSheets(buffer, filename) {
  const ext = String(filename).toLowerCase().split('.').pop();
  if (ext === 'xlsx' || ext === 'xlsm') return parseXlsx(buffer);
  return [{ name: null, matrix: parseCsv(buffer.toString('utf8')) }];
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
