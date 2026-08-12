import fs from 'node:fs';
import path from 'node:path';

import { dataDir } from '../db.js';

/**
 * The last uploaded workbook is kept so that Force Re-sync has something to
 * re-read, so it has to live wherever the database lives.
 *
 * ⚠️ It was `__dirname/../../data` — the source tree — which is the same folder
 * in development and a *different* one on the deployed machine, where the
 * database sits on a mounted volume and the application directory is rebuilt by
 * every deploy. The effect was silent and delayed: uploading a spreadsheet
 * worked, re-syncing worked, and then the first deploy after that turned Force
 * Re-sync into "No spreadsheet has been uploaded yet" with the file gone.
 * Deriving it from the database's directory is what keeps the two together.
 */
const CACHE_DIR = dataDir;

/**
 * A ScheduleSource is anything that can hand back raw tabular data.
 *
 *   id           stable identifier
 *   label        human name for the admin UI
 *   isConfigured() -> boolean
 *   canPull()      -> boolean   (Force Re-sync / polling are available)
 *   pull()         -> Promise<{ buffer, filename, label }>
 *
 * Nothing downstream of this file knows where the bytes came from. Swapping the
 * interim upload flow for a live Sheets connection is a matter of setting env
 * vars — no changes to parsing, diffing, storage, or the client.
 */

/* ------------------------------------------------------------------ *
 * Interim: manual upload
 * ------------------------------------------------------------------ */

/**
 * Keeps the most recent upload on disk, which means "Force Re-sync" does
 * something useful before a live sheet exists: it re-applies the last file.
 */
const uploadSource = {
  id: 'upload',
  label: 'Manual spreadsheet upload',
  kind: 'push',
  isConfigured: () => true,
  canPull() {
    return !!this._cachedPath();
  },
  _cachedPath() {
    for (const ext of ['csv', 'xlsx']) {
      const p = path.join(CACHE_DIR, `last-import.${ext}`);
      if (fs.existsSync(p)) return p;
    }
    return null;
  },
  remember(buffer, filename) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const ext = filename.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
    for (const other of ['csv', 'xlsx']) {
      if (other !== ext) fs.rmSync(path.join(CACHE_DIR, `last-import.${other}`), { force: true });
    }
    fs.writeFileSync(path.join(CACHE_DIR, `last-import.${ext}`), buffer);
    fs.writeFileSync(
      path.join(CACHE_DIR, 'last-import.meta.json'),
      JSON.stringify({ filename, at: new Date().toISOString() }, null, 2)
    );
  },
  lastUpload() {
    const metaPath = path.join(CACHE_DIR, 'last-import.meta.json');
    if (!fs.existsSync(metaPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      return null;
    }
  },
  async pull() {
    const p = this._cachedPath();
    if (!p) throw new Error('No spreadsheet has been uploaded yet.');
    const meta = this.lastUpload();
    return {
      buffer: fs.readFileSync(p),
      filename: path.basename(p),
      label: `Re-sync of last upload${meta ? ` (${meta.filename})` : ''}`,
    };
  },
};

/* ------------------------------------------------------------------ *
 * Live: any published CSV/XLSX URL
 * ------------------------------------------------------------------ */

/**
 * Works today with a Google Sheet published to the web ("File → Share → Publish
 * to web → CSV") or an Excel Online file with a direct download link. No
 * credentials involved.
 */
const urlSource = {
  id: 'url',
  label: 'Published spreadsheet URL',
  kind: 'pull',
  isConfigured: () => !!process.env.SCHEDULE_SOURCE_URL,
  canPull() {
    return this.isConfigured();
  },
  async pull() {
    const url = process.env.SCHEDULE_SOURCE_URL;
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Source URL returned ${res.status} ${res.statusText}`);
    const contentType = res.headers.get('content-type') || '';
    const buffer = Buffer.from(await res.arrayBuffer());
    const isXlsx =
      contentType.includes('spreadsheetml') || /\.xlsx(\?|$)/i.test(url);
    return {
      buffer,
      filename: isXlsx ? 'source.xlsx' : 'source.csv',
      label: 'Sync from published spreadsheet URL',
    };
  },
};

/* ------------------------------------------------------------------ *
 * Live: Google Sheets API v4
 * ------------------------------------------------------------------ */

const googleSheetsSource = {
  id: 'google_sheets',
  label: 'Google Sheets API',
  kind: 'pull',
  isConfigured: () => !!(process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_API_KEY),
  canPull() {
    return this.isConfigured();
  },
  async pull() {
    const id = process.env.GOOGLE_SHEET_ID;
    const key = process.env.GOOGLE_API_KEY;
    const range = process.env.GOOGLE_SHEET_RANGE || 'Schedule!A:I';
    if (!id || !key) {
      throw new Error(
        'Google Sheets sync is not configured. Set GOOGLE_SHEET_ID and GOOGLE_API_KEY, then set SCHEDULE_SOURCE=google_sheets.'
      );
    }
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      id
    )}/values/${encodeURIComponent(range)}?majorDimension=ROWS&key=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google Sheets API returned ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const values = json.values || [];
    // Re-emit as CSV so it re-enters the same parsing path as an upload.
    const csv = values
      .map((row) => row.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    return {
      buffer: Buffer.from(csv, 'utf8'),
      filename: 'sheet.csv',
      label: 'Sync from Google Sheets',
    };
  },
};

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

const SOURCES = {
  upload: uploadSource,
  url: urlSource,
  google_sheets: googleSheetsSource,
};

export function getActiveSource() {
  const configured = SOURCES[process.env.SCHEDULE_SOURCE || 'upload'];
  if (configured && configured.isConfigured()) return configured;
  // Fall back to upload so the app is always usable.
  return uploadSource;
}

export function sourceStatus() {
  const active = getActiveSource();
  return {
    activeId: active.id,
    activeLabel: active.label,
    kind: active.kind,
    canPull: active.canPull(),
    lastUpload: uploadSource.lastUpload(),
    available: Object.values(SOURCES).map((s) => ({
      id: s.id,
      label: s.label,
      kind: s.kind,
      configured: s.isConfigured(),
    })),
  };
}

export { uploadSource, urlSource, googleSheetsSource };
