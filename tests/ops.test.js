/**
 * Item 23 — error tracking, alerting, and what the health check actually
 * promises.
 *
 * The thread running through all of it: *nobody is reading logs during a
 * competition*. So an error that only reached `console.error` did not happen, an
 * alert that fires per-request is muted within a minute and takes the real one
 * with it, and a health check that returns 200 for a server nobody can use is
 * worse than none — it is the thing that stops anyone looking.
 *
 * The heartbeat gets its own section because it is the only mechanism here that
 * survives the failure it is watching for.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-ops-'));
process.env.DB_PATH = path.join(TMP_DIR, 'royalty.db');
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.BACKUP_DIR = path.join(TMP_DIR, 'snapshots');
delete process.env.ALERT_WEBHOOK_URL;
delete process.env.HEARTBEAT_URL;

const {
  errorStats,
  healthReport,
  heartbeatStatus,
  notify,
  opsConfig,
  opsSnapshot,
  recentErrors,
  recordError,
  resetAlertWindow,
  resetHealthCache,
  startHeartbeat,
} = await import('../server/lib/ops.js');
const { backupConfig, takeSnapshot } = await import('../server/lib/backup.js');
const { createApp, errorHandler } = await import('../server/app.js');
const { dataDir } = await import('../server/db.js');

/* ------------------------------- helpers ------------------------------- */

/** A webhook that records what it was sent, and answers however we tell it to. */
async function receiver({ status = 200 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        /* recorded as null */
      }
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(status).end('');
    });
  });
  await new Promise((r) => server.listen(0, r));
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}/hook`,
    close: () => server.close(),
  };
}

function jar() {
  let cookies = {};
  return {
    header: () =>
      Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    absorb(res) {
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        cookies[pair.slice(0, idx)] = pair.slice(idx + 1);
      }
    },
  };
}

let server;
let base;
let admin;

async function call(method, url, { body, cookies } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookies ? { cookie: cookies.header() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  cookies?.absorb(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* a download is not JSON */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

before(async () => {
  // serveClient: false — these tests are about the API, and the health check
  // knows the difference between "no bundle was ever going to be served" and
  // "the bundle is missing", which is the case item 22 found.
  server = http.createServer(createApp({ serveClient: false }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  const c = jar();
  const res = await call('POST', '/api/admin/login', {
    body: { password: 'test-admin-password', name: 'Marcus' },
    cookies: c,
  });
  assert.equal(res.status, 200);
  admin = c;
});

after(() => {
  server?.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

beforeEach(() => resetAlertWindow());

/* ------------------------------- errors -------------------------------- */

describe('errors survive the process', () => {
  test('an error is kept in memory and appended beside the database', () => {
    recordError('test-scope', new Error('the import blew up'), { path: '/api/admin/import' });

    const recent = recentErrors(5);
    assert.equal(recent[0].scope, 'test-scope');
    assert.equal(recent[0].message, 'the import blew up');
    assert.equal(recent[0].path, '/api/admin/import');

    // ⚠️ Beside the database, not in the source tree — the directory every
    // deploy replaces. Same rule as the snapshots and the re-sync cache.
    const logPath = path.join(dataDir, 'errors.log');
    assert.equal(errorStats().logPath, logPath);
    const written = JSON.parse(fs.readFileSync(logPath, 'utf8').trim().split('\n').at(-1));
    assert.equal(written.message, 'the import blew up');
  });

  test('a thrown non-Error is recorded rather than swallowed', () => {
    recordError('test-scope', 'just a string');
    assert.equal(recentErrors(1)[0].message, 'just a string');
  });

  test('the ring buffer is bounded', () => {
    for (let i = 0; i < 80; i++) recordError('flood', new Error(`err ${i}`));
    assert.ok(recentErrors(200).length <= 50);
    assert.equal(recentErrors(1)[0].message, 'err 79', 'newest first');
  });

  test('a 500 from any route lands in the record', async () => {
    // The real middleware, not a copy of it — this is the code path that
    // decides whether an error during the event is written down anywhere.
    const before = errorStats().byScope.http ?? 0;
    const app = express();
    app.get('/boom', () => {
      throw new Error('unexpected');
    });
    app.use(errorHandler);
    const local = http.createServer(app);
    await new Promise((r) => local.listen(0, r));
    const res = await fetch(`http://127.0.0.1:${local.address().port}/boom`);
    local.close();

    assert.equal(res.status, 500);
    assert.equal(errorStats().byScope.http, before + 1);
    assert.equal(recentErrors(1)[0].scope, 'http');
    assert.equal(recentErrors(1)[0].path, '/boom');
  });

  test('a malformed request body is a 400 and is not recorded as a server fault', async () => {
    // Otherwise the panel's error list — the one place someone looks when
    // something is wrong — fills up with things that are not wrong.
    const before = errorStats().byScope.http ?? 0;
    const res = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });

    assert.equal(res.status, 400);
    assert.equal(errorStats().byScope.http ?? 0, before);
  });
});

/* ------------------------------- alerts -------------------------------- */

describe('alerts', () => {
  test('the payload works with Slack and Discord unchanged', async () => {
    const hook = await receiver();
    const result = await notify({
      level: 'error',
      key: 'k1',
      title: 'Something broke',
      detail: 'the details',
      config: { ...opsConfig(), webhookUrl: hook.url, label: 'royalty' },
    });

    assert.equal(result.delivered, true);
    const body = hook.seen[0].body;
    assert.match(body.text, /Something broke/, 'Slack renders `text`');
    assert.match(body.content, /Something broke/, 'Discord renders `content`');
    assert.equal(body.level, 'error');
    assert.equal(body.title, 'Something broke');
    assert.equal(body.detail, 'the details');
    hook.close();
  });

  test('the same condition does not send twice inside the window', async () => {
    const hook = await receiver();
    const config = { ...opsConfig(), webhookUrl: hook.url, windowMs: 60_000 };

    await notify({ key: 'backup-failing', title: 'first', config });
    const second = await notify({ key: 'backup-failing', title: 'second', config });

    assert.equal(second.suppressed, true);
    assert.equal(hook.seen.length, 1, 'one message, not one per occurrence');
    hook.close();
  });

  test('a different condition still gets through', async () => {
    const hook = await receiver();
    const config = { ...opsConfig(), webhookUrl: hook.url, windowMs: 60_000 };

    await notify({ key: 'backup-failing', title: 'backups', config });
    await notify({ key: 'backup-stale', title: 'stale', config });

    assert.equal(hook.seen.length, 2);
    hook.close();
  });

  test('a webhook that rejects is recorded, and never alerted about', async () => {
    // ⚠️ Announcing a broken alert channel through the alert channel is how a
    // webhook outage becomes a loop. The heartbeat is what notices this.
    const hook = await receiver({ status: 500 });
    const result = await notify({
      key: 'k2',
      title: 'anything',
      config: { ...opsConfig(), webhookUrl: hook.url },
    });

    assert.equal(result.ok, false);
    assert.equal(result.delivered, false);
    assert.match(result.error, /500/);
    assert.match(opsSnapshot().alerts.lastError.message, /500/);
    hook.close();
  });

  test('with no webhook configured it still logs and does not throw', async () => {
    const result = await notify({
      key: 'k3',
      title: 'nowhere to go',
      config: { ...opsConfig(), webhookUrl: null },
    });
    assert.equal(result.reason, 'no-webhook');
  });
});

/* ----------------------------- heartbeat ------------------------------- */

describe('heartbeat', () => {
  test('pings immediately and records success', async () => {
    const hook = await receiver();
    const handle = startHeartbeat({
      config: { ...opsConfig(), heartbeatUrl: hook.url, heartbeatMs: 60_000 },
    });

    await new Promise((r) => setTimeout(r, 200));
    handle.stop();

    assert.equal(handle.started, true);
    assert.equal(hook.seen.length, 1);
    assert.equal(hook.seen[0].method, 'GET');
    assert.ok(heartbeatStatus().lastOkAt);
    hook.close();
  });

  test('a failing ping is counted, not alerted — the far side is the alarm', async () => {
    const hook = await receiver({ status: 500 });
    const handle = startHeartbeat({
      config: { ...opsConfig(), heartbeatUrl: hook.url, heartbeatMs: 60_000 },
    });

    await new Promise((r) => setTimeout(r, 200));
    handle.stop();

    assert.equal(heartbeatStatus().failures, 1);
    assert.match(heartbeatStatus().lastError, /500/);
    hook.close();
  });

  test('unset means off, rather than a timer pinging nothing', () => {
    const handle = startHeartbeat({ config: { ...opsConfig(), heartbeatUrl: null } });
    assert.equal(handle.started, false);
  });
});

/* -------------------------------- health ------------------------------- */

describe('/api/health', () => {
  test('answers 200 with the database reachable', async () => {
    const res = await call('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.checks.database.ok, true);
    assert.ok(res.body.updatedAt, 'still carries what it always carried');
  });

  test('needs no session — an outside monitor has no code', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
  });

  test('carries no event data', async () => {
    const res = await call('GET', '/api/health');
    const text = JSON.stringify(res.body);
    assert.ok(!/people|teams|blocks|schedule_/.test(text.replace(/updatedAt/g, '')));
  });

  test('a missing client build is a 503, not a green 200', () => {
    /**
     * ⚠️ The whole reason this endpoint is more than `{ok:true}`. Item 22 found
     * that a deploy with no bundle answers every phone with the plain-text
     * "API is running" placeholder — a 200, so the uptime monitor and the
     * platform health check both stay green while the venue sees nothing.
     */
    resetHealthCache();
    const report = healthReport({ clientDist: path.join(TMP_DIR, 'no-such-build'), serveClient: true });
    assert.equal(report.ok, false);
    assert.equal(report.checks.clientBuild.ok, false);
    resetHealthCache();
  });

  test('stale backups are reported but never fail it', async () => {
    // Someone should be woken for this — by the panel and the alert channel,
    // not by taking a site "down" that is serving 280 people correctly.
    const report = healthReport({ serveClient: false });
    assert.equal(report.ok, true);
    assert.equal(typeof report.backups.ok, 'boolean');
  });
});

/* ------------------------------ the panel ------------------------------ */

describe('the ops tab', () => {
  test('everything under /api/admin/ops requires an admin', async () => {
    for (const [method, url] of [
      ['GET', '/api/admin/ops'],
      ['GET', '/api/admin/ops/backups'],
      ['POST', '/api/admin/ops/backup'],
      ['POST', '/api/admin/ops/test-alert'],
      ['GET', '/api/admin/ops/snapshots/royalty-20260808-130500Z.db'],
    ]) {
      const res = await call(method, url);
      assert.equal(res.status, 401, `${method} ${url} without a session`);
    }
  });

  test('reports snapshots, errors and the alert configuration', async () => {
    const res = await call('GET', '/api/admin/ops', { cookies: admin });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.snapshots));
    assert.ok(Array.isArray(res.body.errors.recent));
    assert.equal(typeof res.body.backups.enabled, 'boolean');
    assert.equal(res.body.alerts.configured, false);
  });

  test('an admin can take one on the spot — the "before I run the import" case', async () => {
    const res = await call('POST', '/api/admin/ops/backup', { cookies: admin });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.counts);

    const listed = await call('GET', '/api/admin/ops', { cookies: admin });
    assert.ok(listed.body.snapshots.length >= 1);
  });

  test('a snapshot can be downloaded, and only by its own name', async () => {
    await takeSnapshot({ config: backupConfig() });
    const { snapshots } = (await call('GET', '/api/admin/ops', { cookies: admin })).body;

    const ok = await call('GET', `/api/admin/ops/snapshots/${snapshots[0].name}`, { cookies: admin });
    assert.equal(ok.status, 200);

    // ⚠️ A whitelist, not sanitization: an admin-supplied path reaching
    // sendFile is how a panel becomes a way to read arbitrary files.
    for (const attempt of ['../royalty.db', '..%2Froyalty.db', 'royalty.db', 'nope.db']) {
      const res = await call('GET', `/api/admin/ops/snapshots/${attempt}`, { cookies: admin });
      assert.ok(res.status === 400 || res.status === 404, `${attempt} → ${res.status}`);
    }
  });

  test('the test alert refuses when there is nowhere to send it', async () => {
    const res = await call('POST', '/api/admin/ops/test-alert', { cookies: admin });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /ALERT_WEBHOOK_URL/);
  });

  test('the test alert bypasses the dedupe window, twice in a row', async () => {
    // Testing a channel and being told the test was suppressed is not a test.
    const hook = await receiver();
    process.env.ALERT_WEBHOOK_URL = hook.url;
    try {
      const first = await call('POST', '/api/admin/ops/test-alert', { cookies: admin });
      const second = await call('POST', '/api/admin/ops/test-alert', { cookies: admin });
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(hook.seen.length, 2);
      assert.match(hook.seen[1].body.detail, /Marcus/);
    } finally {
      delete process.env.ALERT_WEBHOOK_URL;
      hook.close();
    }
  });
});
