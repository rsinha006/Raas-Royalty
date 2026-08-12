import path from 'node:path';

import express from 'express';

import {
  SNAPSHOT_RE,
  backupConfig,
  backupStatus,
  listSnapshots,
  takeSnapshot,
} from '../lib/backup.js';
import { notify, opsSnapshot, resetAlertWindow } from '../lib/ops.js';
import { editorName } from '../lib/auth.js';

/**
 * The Ops tab — item 23's half of the panel.
 *
 * Everything here is behind `requireAdmin` (mounted after it in admin.js), and
 * that matters more than it looks: a snapshot is the entire event database,
 * access codes included. It is the same material the codes export already
 * hands out, which is why downloading one is allowed at all — but it is not
 * something to leave reachable without a password.
 *
 * The two buttons exist because both answer a question you do not want to be
 * asking for the first time during the event: "is there a copy of this from
 * before I run the import" and "does the thing that pages me actually work".
 */
export function adminOpsRouter() {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({ ...opsSnapshot(), snapshots: listSnapshots(backupConfig().dir).slice(0, 20) });
  });

  /**
   * Take one now. The obvious use is right before something irreversible — an
   * import, a bulk shift, a roster delete — where undo covers the schedule but
   * not a mistake nobody has noticed yet.
   */
  router.post('/backup', async (req, res) => {
    const record = await takeSnapshot({ config: backupConfig() });
    if (!record.ok) return res.status(500).json({ error: record.error });
    res.json({ ...record, by: editorName(req) });
  });

  /**
   * Prove the alert path end to end, from this process to whatever is on
   * someone's phone. Bypasses the deduplication window — testing a channel and
   * being told the test was suppressed is not a test.
   */
  router.post('/test-alert', async (req, res) => {
    resetAlertWindow('test-alert');
    const result = await notify({
      level: 'info',
      key: 'test-alert',
      title: 'Test alert from the logistics panel',
      detail: `Sent by ${editorName(req)}. If you are reading this, the alert path works.`,
    });
    if (result.reason === 'no-webhook') {
      return res.status(400).json({
        error: 'No ALERT_WEBHOOK_URL is set, so there is nowhere to send it. See docs/ops.md.',
      });
    }
    if (!result.delivered) {
      return res.status(502).json({ error: result.error || 'The webhook did not accept it.' });
    }
    res.json({ ok: true });
  });

  /**
   * Download one. ⚠️ The name is matched against the snapshot pattern rather
   * than sanitized — an admin-supplied path that reaches `sendFile` is how a
   * panel becomes a way to read `/etc/passwd`, and a whitelist has no clever
   * encodings to get wrong.
   */
  router.get('/snapshots/:name', (req, res) => {
    const name = String(req.params.name || '');
    if (!SNAPSHOT_RE.test(name)) return res.status(400).json({ error: 'Not a snapshot name.' });
    const config = backupConfig();
    if (!listSnapshots(config.dir).some((s) => s.name === name)) {
      return res.status(404).json({ error: 'No such snapshot.' });
    }
    res.download(path.join(config.dir, name), name);
  });

  /** Cheap enough for the overview banner to poll without the rest. */
  router.get('/backups', (req, res) => {
    res.json(backupStatus());
  });

  return router;
}
