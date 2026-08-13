import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { dataDir, scheduleUpdatedAt } from '../db.js';
import { CLIENT_DIST } from './deploy-config.js';
import { backupStatus } from './backup.js';
import { releasePayload } from './release.js';

/**
 * Error tracking, alerting and the health check — PLAN.md item 23.
 *
 * The premise of this whole file is one sentence from the plan: *you will not
 * be reading server logs during a competition*. Whoever is on call is holding a
 * clipboard in a loud gym. So the requirements are narrow and unusual:
 *
 *   - **Errors have to survive.** `console.error` scrolls away and `fly logs`
 *     only shows what happened while someone was watching. They go to a file on
 *     the volume, and to a ring buffer the panel can show.
 *   - **The alert has to leave the machine.** A process that has crashed cannot
 *     send anything, so the *only* reliable "the app is down" alert is one that
 *     fires when an outside service stops hearing from us. That is the
 *     heartbeat, and it is why the uptime monitor — not this file — owns SMS.
 *   - **It must not cry wolf.** Alerts are deduplicated by key over a window;
 *     an error in a route that 280 phones are hitting would otherwise send one
 *     message per phone and be muted by the recipient inside a minute.
 *
 * See docs/ops.md for the runbook and how the outside pieces are configured.
 */

const ERROR_LOG = path.join(dataDir, 'errors.log');
const ERROR_LOG_MAX_BYTES = 1024 * 1024;
const RING_SIZE = 50;
const DEFAULT_ALERT_WINDOW_MS = 5 * 60_000;
const DEFAULT_HEARTBEAT_MS = 60_000;
const OUTBOUND_TIMEOUT_MS = 10_000;

const ring = [];
const counts = new Map();
const alertedAt = new Map();
let alertsSent = 0;
let alertsSuppressed = 0;
let lastAlert = null;
let lastAlertError = null;
let heartbeat = { configured: false, lastOkAt: null, lastError: null, failures: 0 };
const startedAt = Date.now();

export function opsConfig(env = process.env) {
  return {
    webhookUrl: env.ALERT_WEBHOOK_URL || null,
    windowMs: Number(env.ALERT_MIN_INTERVAL_MS ?? DEFAULT_ALERT_WINDOW_MS),
    heartbeatUrl: env.HEARTBEAT_URL || null,
    heartbeatMs: Number(env.HEARTBEAT_INTERVAL_MS ?? DEFAULT_HEARTBEAT_MS),
    label: env.FLY_APP_NAME || env.APP_LABEL || 'royalty',
  };
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * Record one error. Never throws — an error handler that can fail is a second
 * error nobody sees, and this one runs inside the Express error middleware and
 * inside `process.on('uncaughtException')`.
 */
export function recordError(scope, err, context = {}) {
  const entry = {
    at: new Date().toISOString(),
    scope,
    message: String(err?.message ?? err ?? 'Unknown error'),
    stack: typeof err?.stack === 'string' ? err.stack.split('\n').slice(0, 6).join('\n') : null,
    ...context,
  };

  ring.push(entry);
  while (ring.length > RING_SIZE) ring.shift();
  counts.set(entry.scope, (counts.get(entry.scope) ?? 0) + 1);

  console.error(`[error:${scope}] ${entry.message}`);
  appendErrorLine(entry);
  return entry;
}

/**
 * One JSON object per line, beside the database so it outlives both the
 * container and whatever was scrolling in `fly logs`. Rotated at 1MB into a
 * single `.1` — enough to read the run-up to whatever broke, and bounded so a
 * crash loop cannot fill the volume the database is on.
 */
function appendErrorLine(entry) {
  try {
    if (fs.existsSync(ERROR_LOG) && fs.statSync(ERROR_LOG).size > ERROR_LOG_MAX_BYTES) {
      fs.renameSync(ERROR_LOG, `${ERROR_LOG}.1`);
    }
    fs.appendFileSync(ERROR_LOG, `${JSON.stringify(entry)}\n`);
  } catch {
    /* the ring buffer still has it; a full or read-only disk is its own alarm */
  }
}

export function recentErrors(limit = RING_SIZE) {
  return ring.slice(-limit).reverse();
}

export function errorStats() {
  return {
    total: [...counts.values()].reduce((a, b) => a + b, 0),
    byScope: Object.fromEntries(counts),
    logPath: ERROR_LOG,
  };
}

/* ------------------------------------------------------------------ *
 * Alerts
 * ------------------------------------------------------------------ */

/**
 * Send one alert to whatever `ALERT_WEBHOOK_URL` points at.
 *
 * The payload carries `text` *and* `content` alongside the structured fields,
 * which is not redundancy for its own sake: Slack incoming webhooks render
 * `text`, Discord renders `content`, and anything custom reads the fields. One
 * env var then works with whichever the on-call person already has on their
 * phone, with no adapter in this repo to keep in step.
 *
 * `key` is what deduplication is done on, and it should name the *condition*
 * rather than the occurrence — "backup-failed", not the message with a
 * timestamp in it.
 */
export async function notify({ level = 'warn', key, title, detail = '', config = opsConfig() }) {
  const now = Date.now();
  const dedupeKey = key || title;
  const previous = alertedAt.get(dedupeKey);
  if (previous && now - previous < config.windowMs) {
    alertsSuppressed += 1;
    return { ok: false, suppressed: true, key: dedupeKey };
  }
  alertedAt.set(dedupeKey, now);

  const line = `[${level}] ${config.label}: ${title}`;
  lastAlert = { at: new Date().toISOString(), level, key: dedupeKey, title, detail };
  console.warn(`${line}${detail ? ` — ${detail}` : ''}`);

  if (!config.webhookUrl) return { ok: false, delivered: false, key: dedupeKey, reason: 'no-webhook' };

  const body = {
    text: `${line}${detail ? `\n${detail}` : ''}`,
    content: `${line}${detail ? `\n${detail}` : ''}`,
    level,
    key: dedupeKey,
    title,
    detail,
    app: config.label,
    host: os.hostname(),
    at: lastAlert.at,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
  try {
    const res = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    alertsSent += 1;
    lastAlertError = null;
    return { ok: true, delivered: true, key: dedupeKey };
  } catch (err) {
    /**
     * ⚠️ Recorded, never re-alerted. The failure of the alert channel cannot be
     * announced through the alert channel, and trying is how a webhook outage
     * becomes an infinite loop. The heartbeat is the outside observer that
     * notices this class of problem.
     */
    lastAlertError = { at: new Date().toISOString(), message: err.message };
    console.error(`[alert] could not deliver: ${err.message}`);
    return { ok: false, delivered: false, key: dedupeKey, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam, and what "Send a test alert" in the panel uses to bypass the window. */
export function resetAlertWindow(key = null) {
  if (key) alertedAt.delete(key);
  else alertedAt.clear();
}

/* ------------------------------------------------------------------ *
 * Heartbeat — the only alarm that works when this process does not
 * ------------------------------------------------------------------ */

/**
 * Ping an external dead-man's switch (healthchecks.io, Better Stack, Cronitor,
 * an uptime monitor's push URL) on an interval. When the pings stop, *that*
 * service sends the SMS.
 *
 * ⚠️ This is the item's "SMS to whoever is on call", and it has to be an
 * outside service by construction. A machine that has run out of disk, wedged
 * its event loop, or been killed cannot notice anything about itself — every
 * check that lives in here shares its fate. The webhook alerts above are for
 * problems the process is still healthy enough to describe.
 */
export function startHeartbeat({ config = opsConfig(), fetchImpl = fetch } = {}) {
  if (!config.heartbeatUrl) return { started: false, stop() {} };
  heartbeat = { configured: true, lastOkAt: null, lastError: null, failures: 0 };

  const ping = async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
    try {
      const res = await fetchImpl(config.heartbeatUrl, { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      heartbeat.lastOkAt = new Date().toISOString();
      heartbeat.failures = 0;
      heartbeat.lastError = null;
    } catch (err) {
      heartbeat.failures += 1;
      heartbeat.lastError = err.message;
      /**
       * Deliberately quiet: a failed heartbeat usually means our own network is
       * unhappy, and the far side is about to raise exactly this alarm itself.
       * Logging every one would bury the errors that need reading.
       */
      if (heartbeat.failures === 1 || heartbeat.failures % 10 === 0) {
        console.warn(`[heartbeat] ${heartbeat.failures} consecutive failures: ${err.message}`);
      }
    } finally {
      clearTimeout(t);
    }
  };

  const timer = setInterval(ping, Math.max(config.heartbeatMs, 10_000));
  timer.unref?.();
  ping();
  return {
    started: true,
    stop() {
      clearInterval(timer);
    },
  };
}

export function heartbeatStatus() {
  return { ...heartbeat };
}

/* ------------------------------------------------------------------ *
 * Process-level handlers
 * ------------------------------------------------------------------ */

/**
 * An uncaught exception leaves the process in a state nobody has reasoned
 * about, so it records, alerts, and *exits* — the platform restarts the machine
 * in seconds, phones already hold the shell, and sockets reconnect on their
 * own. Limping on with indeterminate state is the option that produces a wrong
 * schedule rather than a brief absence of one, and wrong is the failure this
 * project exists to avoid.
 *
 * The grace period exists so the webhook has a chance to leave before the
 * process does.
 */
export function installProcessHandlers({ exit = true, graceMs = 1_500 } = {}) {
  const handle = (scope, exiting) => async (err) => {
    recordError(scope, err);
    await notify({
      level: 'error',
      key: `${scope}:${String(err?.message ?? err).slice(0, 80)}`,
      title: exiting ? 'Server crashed and is restarting' : 'Unhandled promise rejection',
      detail: String(err?.stack ?? err).slice(0, 800),
    }).catch(() => {});
    if (exiting && exit) {
      setTimeout(() => process.exit(1), graceMs).unref?.();
    }
  };

  process.on('uncaughtException', handle('uncaught-exception', true));
  process.on('unhandledRejection', handle('unhandled-rejection', false));
}

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

/**
 * Cached because `/api/health` is also the load test's latency probe and the
 * platform's own check every 15 seconds, and neither should be paying for a
 * `stat` — the client build cannot appear or vanish without a restart. Item 20
 * measured this endpoint at one indexed row; keep it there.
 */
let clientBuildOk = null;

/**
 * What an uptime monitor gets. Non-200 means *phones are not being served*, and
 * nothing else — because a monitor that pages on a degraded-but-working
 * condition gets ignored, and then the page that matters is ignored too.
 *
 * ⚠️ The client-build check is the reason this is more than `{ok:true}`. Item
 * 22 found that a deploy with no bundle answers every request with a 200 and
 * the plain-text "API is running" placeholder: the monitor stays green, the
 * platform's health check stays green, and every phone at the venue shows
 * nothing. The boot gate refuses that in production; this catches it in every
 * environment, and catches it after boot too.
 */
export function healthReport({ clientDist = CLIENT_DIST, serveClient = true } = {}) {
  const checks = {};
  let ok = true;

  try {
    checks.database = { ok: true, updatedAt: scheduleUpdatedAt() };
  } catch (err) {
    checks.database = { ok: false, error: err.message };
    ok = false;
  }

  if (serveClient) {
    if (clientBuildOk === null) clientBuildOk = fs.existsSync(path.join(clientDist, 'index.html'));
    checks.clientBuild = { ok: clientBuildOk };
    if (!clientBuildOk) ok = false;
  }

  /**
   * Reported, never fatal. Backups being stale is a real problem and someone
   * should be woken for it — by the panel and by the alert channel, not by
   * taking the site "down" in a monitor and sending someone to fix a server
   * that is serving 280 people correctly.
   */
  let backups = null;
  try {
    const status = backupStatus();
    backups = {
      ok: !status.stale,
      enabled: status.enabled,
      ageSeconds: status.ageSeconds,
      offBox: Boolean(status.offBox),
    };
  } catch (err) {
    backups = { ok: false, error: err.message };
  }

  return {
    ok,
    updatedAt: checks.database.updatedAt ?? null,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    checks,
    backups,
    /**
     * Item 27. Reported, never fatal — a machine that cannot name its release
     * is serving 280 people perfectly well, and 503ing over it would take the
     * event down to fix a labelling problem.
     *
     * It is here rather than only in the panel because this is the endpoint
     * reachable from outside without a password: `npm run freeze -- --url …`
     * asks it whether the machine is holding the release that was frozen, and
     * that comparison needs the half that the laptop cannot know. Memoized in
     * release.js — this path stays at one indexed row.
     */
    release: releasePayload(),
    at: new Date().toISOString(),
  };
}

/** Test seam: the cached `existsSync`. */
export function resetHealthCache() {
  clientBuildOk = null;
}

/** Everything the ops tab in the panel renders. */
export function opsSnapshot() {
  const config = opsConfig();
  return {
    release: releasePayload(),
    backups: backupStatus(),
    errors: { ...errorStats(), recent: recentErrors(20) },
    alerts: {
      configured: Boolean(config.webhookUrl),
      windowMs: config.windowMs,
      sent: alertsSent,
      suppressed: alertsSuppressed,
      last: lastAlert,
      lastError: lastAlertError,
    },
    heartbeat: { ...heartbeatStatus(), configured: Boolean(config.heartbeatUrl), intervalMs: config.heartbeatMs },
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    startedAt: new Date(startedAt).toISOString(),
  };
}
