/**
 * Load test — item 20. Numbers, not reassurance.
 *
 * The event is sized for 280 people (docs/decisions.md); this drives 600
 * concurrent viewers against a server holding a 280-person roster, which is the
 * 2× headroom that decision asked for. It is not a synthetic benchmark of one
 * endpoint: every virtual client does what a phone does — redeems a code, picks
 * its name if it holds a team code, holds a socket open, and refetches
 * `/api/schedule` the moment a change reaches its rooms, with no debounce,
 * exactly as `ScheduleScreen.tsx` does.
 *
 * What it measures, in the order the numbers matter:
 *
 *   1. **Sign-in and connect** — 600 codes redeemed and 600 sockets opened.
 *   2. **One team's edit** — the common case, and the scoping check: how many
 *      of the 600 were woken, against how many the edit log says it affects.
 *   3. **A burst of edits** — a run of single-block saves back to back, which is
 *      what a late afternoon actually looks like from the panel.
 *   4. **A bulk shift** — item 15's "everything from 3pm moves 20 minutes",
 *      previewed and applied, one request that moves a whole afternoon.
 *   5. **An announcement** — the worst case by construction: `everyone` is in
 *      every session's targets, so all 600 refetch at once.
 *   6. **A mass reconnect** — every socket dropped simultaneously, which is
 *      venue wifi, a deploy, or a room full of phones coming off standby. The
 *      client refetches on disconnect *and* on reconnect, so this is the
 *      heaviest of the six.
 *
 * Structure: the clients run in forked workers (default 4) so that one Node
 * event loop is not simultaneously the bottleneck and the instrument. The
 * parent drives the admin actions and correlates.
 *
 *   node scripts/load-test.js                       # the full run, 600 clients
 *   node scripts/load-test.js --clients 280         # at real scale
 *   node scripts/load-test.js --url http://host     # against a deployed server
 *   node scripts/load-test.js --json out.json       # machine-readable results
 *
 * ⚠️ Client and server share this machine unless `--url` points elsewhere, so
 * the numbers include the harness competing for the same cores. That direction
 * is the safe one — a real deploy has the server to itself — but it means a
 * slow result here is a ceiling, not a verdict.
 */
import { fork, spawn, execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = {
    clients: 600,
    workers: 4,
    port: 4100,
    url: null,
    db: path.join(ROOT, 'data', 'load-test.db'),
    people: 280,
    blocks: 350,
    ramp: 60, // sign-ins started per second, per the whole run
    adminPassword: 'load-test-admin',
    json: null,
    skipFixture: false,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const [flag, inlineValue] = argv[i].split('=');
    const next = () => inlineValue ?? argv[++i];
    switch (flag) {
      case '--clients': opts.clients = Number(next()); break;
      case '--workers': opts.workers = Number(next()); break;
      case '--port': opts.port = Number(next()); break;
      case '--url': opts.url = next(); break;
      case '--db': opts.db = path.resolve(next()); break;
      case '--people': opts.people = Number(next()); break;
      case '--blocks': opts.blocks = Number(next()); break;
      case '--ramp': opts.ramp = Number(next()); break;
      case '--json': opts.json = path.resolve(next()); break;
      case '--skip-fixture': opts.skipFixture = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--worker': break;
      default:
        if (flag.startsWith('--')) throw new Error(`unknown option ${flag}`);
    }
  }
  return opts;
}

/* ------------------------------------------------------------------ *
 * HTTP — one keep-alive connection per virtual client
 *
 * Deliberately not `fetch`, whose global dispatcher would pool 150 clients onto
 * a handful of sockets: the queueing that produces shows up as server latency
 * in the results and is not. One agent per client with `maxSockets: 1` is what
 * a phone actually looks like.
 * ------------------------------------------------------------------ */

function newAgent() {
  return new http.Agent({ keepAlive: true, maxSockets: 1 });
}

function request(base, urlPath, { method = 'GET', headers = {}, body = null, agent = null } = {}) {
  const url = new URL(urlPath, base);
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        agent: agent || undefined,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not every response is JSON */
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            setCookie: res.headers['set-cookie'] || [],
            text,
            json,
            ms: performance.now() - started,
          });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const cookieValue = (setCookie, name) => {
  for (const raw of setCookie) {
    const [pair] = String(raw).split(';');
    const eq = pair.indexOf('=');
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
};

/* ------------------------------------------------------------------ *
 * Stats
 * ------------------------------------------------------------------ */

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(values) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0 };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

const ms = (v) => (v == null ? '—' : `${v.toFixed(0)}ms`);
const row = (label, s) =>
  s && s.n
    ? `    ${label.padEnd(34)} n=${String(s.n).padStart(4)}  p50 ${ms(s.p50).padStart(7)}  ` +
      `p95 ${ms(s.p95).padStart(7)}  p99 ${ms(s.p99).padStart(7)}  max ${ms(s.max).padStart(7)}`
    : `    ${label.padEnd(34)} (no samples)`;

/* ================================================================== *
 * Worker — the virtual phones
 * ================================================================== */

async function runWorker() {
  const { io } = await import('socket.io-client');

  let base = null;
  const clients = [];
  /** Every observation this worker made, drained by the parent per scenario. */
  let samples = [];

  const record = (rec) => samples.push({ at: Date.now(), ...rec });

  class VirtualClient {
    constructor(spec) {
      this.spec = spec;
      this.agent = newAgent();
      this.cookie = null;
      this.socket = null;
      this.subjectId = null;
      /** Guards against overlapping refetches, exactly as one phone would. */
      this.fetching = false;
    }

    headers() {
      return this.cookie ? { cookie: `royalty_session=${this.cookie}` } : {};
    }

    async signIn() {
      const t0 = performance.now();
      const res = await request(base, '/api/session', {
        method: 'POST',
        body: { code: this.spec.code },
        agent: this.agent,
      });
      if (res.status !== 200) throw new Error(`sign-in ${res.status}: ${res.text.slice(0, 120)}`);
      this.cookie = cookieValue(res.setCookie, 'royalty_session');

      let identifyMs = null;
      if (res.json?.needsIdentity) {
        // A team code lands on "which dancer are you?", and the answer is what
        // makes person-targeted blocks reach the phone. Modelled, not skipped:
        // it is the path ~85% of the roster takes.
        const roster = await request(base, '/api/session/roster', {
          headers: this.headers(),
          agent: this.agent,
        });
        const people = roster.json?.people || [];
        if (!people.length) throw new Error('team code with an empty roster');
        const person = people[this.spec.memberIndex % people.length];
        const t1 = performance.now();
        const identified = await request(base, '/api/session/identify', {
          method: 'POST',
          body: { personId: person.id },
          headers: this.headers(),
          agent: this.agent,
        });
        if (identified.status !== 200) throw new Error(`identify ${identified.status}`);
        this.cookie = cookieValue(identified.setCookie, 'royalty_session') || this.cookie;
        identifyMs = performance.now() - t1;
      }

      const schedule = await this.fetchSchedule('first-load');
      this.subjectId = schedule.subjectId;
      return { signInMs: performance.now() - t0, identifyMs, blocks: schedule.blocks };
    }

    async fetchSchedule(kind) {
      if (this.fetching) return { skipped: true };
      this.fetching = true;
      try {
        const res = await request(base, '/api/schedule', {
          headers: this.headers(),
          agent: this.agent,
        });
        record({ kind, fetchMs: res.ms, status: res.status, client: this.spec.id });
        return {
          blocks: res.json?.blocks?.length ?? 0,
          subjectId: res.json?.subject?.id ?? null,
          status: res.status,
        };
      } catch (err) {
        record({ kind, error: String(err.message), client: this.spec.id });
        return { status: 0 };
      } finally {
        this.fetching = false;
      }
    }

    connect() {
      const t0 = performance.now();
      return new Promise((resolve, reject) => {
        // Same options as client/src/live.ts, so a reconnect storm here backs
        // off the way the real app's would.
        const socket = io(base, {
          transports: ['websocket'],
          extraHeaders: { cookie: `royalty_session=${this.cookie}` },
          reconnectionDelay: 500,
          reconnectionDelayMax: 5000,
          timeout: 20_000,
        });
        this.socket = socket;

        socket.on('schedule:updated', () => {
          record({ kind: 'event', event: 'schedule:updated', client: this.spec.id, subject: this.subjectId });
          this.fetchSchedule('refetch');
        });
        socket.on('roster:updated', () => {
          record({ kind: 'event', event: 'roster:updated', client: this.spec.id, subject: this.subjectId });
          this.fetchSchedule('refetch');
        });
        socket.on('disconnect', () => {
          // live.ts treats a dropped socket as a hint, not a verdict: it
          // refetches immediately rather than trusting the disconnect.
          record({ kind: 'disconnect', client: this.spec.id });
          this.fetchSchedule('disconnect-refetch');
        });
        socket.on('connect', () => {
          if (this.connectedOnce) record({ kind: 'reconnect', client: this.spec.id });
          this.connectedOnce = true;
          resolve({ connectMs: performance.now() - t0 });
        });
        socket.on('connect_error', (err) => {
          record({ kind: 'connect_error', client: this.spec.id, error: String(err.message) });
          reject(err);
        });
      });
    }
  }

  const handlers = {
    async init({ baseUrl, specs, ramp }) {
      base = baseUrl;
      const gapMs = ramp > 0 ? 1000 / ramp : 0;
      const signIn = [];
      const identify = [];
      const connect = [];
      const failures = [];
      let blocksSeen = 0;

      await Promise.all(
        specs.map(async (spec, i) => {
          if (gapMs) await sleep(i * gapMs);
          const client = new VirtualClient(spec);
          clients.push(client);
          try {
            const s = await client.signIn();
            signIn.push(s.signInMs);
            if (s.identifyMs != null) identify.push(s.identifyMs);
            blocksSeen += s.blocks;
            const c = await client.connect();
            connect.push(c.connectMs);
          } catch (err) {
            failures.push(String(err.message));
          }
        })
      );
      return { signIn, identify, connect, failures, blocksSeen, connected: clients.length };
    },

    /** Drop every socket at once. The client refetches, then reconnects. */
    async reconnectAll() {
      for (const c of clients) {
        if (c.socket) {
          c.socket.disconnect();
          c.socket.connect();
        }
      }
      return { dropped: clients.length };
    },

    count() {
      return { count: samples.length };
    },

    drain() {
      const out = samples;
      samples = [];
      return { samples: out };
    },

    reset() {
      samples = [];
      return { ok: true };
    },

    async shutdown() {
      for (const c of clients) c.socket?.close();
      return { ok: true };
    },
  };

  process.on('message', async (msg) => {
    if (!msg || !msg.id) return;
    try {
      const result = await handlers[msg.type](msg.payload || {});
      process.send({ id: msg.id, ok: true, result });
    } catch (err) {
      process.send({ id: msg.id, ok: false, error: String(err?.stack || err) });
    }
  });
  process.send({ ready: true });
}

/* ================================================================== *
 * Parent — the server, the admin, and the scenarios
 * ================================================================== */

async function waitForHealth(base, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request(base, '/api/health');
      if (res.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}

/** Cumulative CPU seconds and RSS for a pid, via ps. */
function sampleProcess(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'rss=,time=', '-p', String(pid)], (err, stdout) => {
      if (err || !stdout.trim()) return resolve(null);
      const [rss, time] = stdout.trim().split(/\s+/);
      const parts = String(time).split(/[:.]/).map(Number); // [mm, ss, cc] or [hh, mm, ss, cc]
      let seconds = 0;
      if (parts.length === 3) seconds = parts[0] * 60 + parts[1] + parts[2] / 100;
      else if (parts.length === 4) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / 100;
      resolve({ at: Date.now(), rssMb: Number(rss) / 1024, cpuSeconds: seconds });
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  const log = (...a) => !opts.quiet && console.log(...a);
  const results = { startedAt: new Date().toISOString(), opts: { ...opts }, scenarios: {} };

  /* ---------------------------- fixture ---------------------------- */

  let server = null;
  let base = opts.url;
  if (!opts.url) {
    log('\n▶ Fixture');
    if (!opts.skipFixture) {
      const { buildFixture } = await import('./load-fixture.js');
      results.fixture = await buildFixture({ dbPath: opts.db, people: opts.people, blocks: opts.blocks });
    } else {
      log('  (reusing the existing fixture)');
    }

    log('\n▶ Server');
    base = `http://127.0.0.1:${opts.port}`;
    server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: {
        ...process.env,
        DB_PATH: opts.db,
        PORT: String(opts.port),
        // The deploy target's settings, minus the one that would break plain
        // HTTP on localhost. NODE_ENV matters: it is what turns off the
        // localhost/LAN socket-origin allowance.
        NODE_ENV: 'production',
        INSECURE_COOKIES: '1',
        ADMIN_PASSWORD: opts.adminPassword,
        SESSION_SECRET: 'load-test-secret',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const serverErrors = [];
    server.stdout.on('data', (d) => {
      const text = String(d);
      if (/error|warn/i.test(text)) serverErrors.push(text.trim());
    });
    server.stderr.on('data', (d) => serverErrors.push(String(d).trim()));
    results.serverErrors = serverErrors;

    if (!(await waitForHealth(base))) {
      server.kill();
      throw new Error(`server did not come up:\n${serverErrors.join('\n')}`);
    }
    log(`  up on ${base} (pid ${server.pid}), NODE_ENV=production, DB_PATH=${path.relative(ROOT, opts.db)}`);
  }

  /* ------------------- health probe + resource sampler ------------------- *
   * The server is one process doing synchronous SQLite work, so "is it
   * blocked?" is the question that matters most. A 250ms probe against
   * /api/health — which touches one indexed row and nothing else — answers it:
   * every millisecond over the idle baseline is the event loop being held.
   * ---------------------------------------------------------------------- */

  const probes = [];
  const probeAgent = newAgent();
  let probing = true;
  const probeLoop = (async () => {
    while (probing) {
      try {
        const res = await request(base, '/api/health', { agent: probeAgent });
        probes.push({ at: Date.now(), ms: res.ms, status: res.status });
      } catch (err) {
        probes.push({ at: Date.now(), ms: null, status: 0, error: String(err.message) });
      }
      await sleep(250);
    }
  })();

  const resource = [];
  let sampling = Boolean(server);
  const resourceLoop = (async () => {
    while (sampling) {
      const s = await sampleProcess(server.pid);
      if (s) resource.push(s);
      await sleep(500);
    }
  })();

  /* ---------------------------- admin ---------------------------- */

  const adminAgent = newAgent();
  const login = await request(base, '/api/admin/login', {
    method: 'POST',
    body: { password: opts.adminPassword, name: 'load-test' },
    agent: adminAgent,
  });
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status} ${login.text}`);
  const adminCookie = cookieValue(login.setCookie, 'royalty_admin');
  const asAdmin = (urlPath, init = {}) =>
    request(base, urlPath, {
      ...init,
      headers: { ...(init.headers || {}), cookie: `royalty_admin=${adminCookie}` },
      agent: init.agent || adminAgent,
    });

  const codes = (await asAdmin('/api/admin/codes')).json;
  const teamCodes = codes.codes.filter((c) => c.subjectType === 'team' && !c.revokedAt && !c.orphaned);
  const staffCodes = codes.codes.filter((c) => c.subjectType === 'person' && !c.revokedAt && !c.orphaned);
  const roster = (await asAdmin('/api/admin/roster')).json;
  const blocks = (await asAdmin('/api/admin/blocks')).json.blocks;

  /* --------------------------- client plan --------------------------- *
   * Staff hold personal codes, dancers reach their schedule through their
   * team's code plus the identity step — so the mix here is the roster's mix,
   * not 600 copies of one session. Beyond the roster's size the plan wraps,
   * which models the same person on a second device: a real property of the
   * event, since a captain reads the team code off one phone and their own.
   * --------------------------------------------------------------------- */

  const specs = [];
  const dancersPerTeam = new Map();
  let dancerSeat = 0;
  for (let i = 0; i < opts.clients; i++) {
    const useStaff = staffCodes.length && i % 8 === 7;
    if (useStaff) {
      specs.push({ id: i, code: staffCodes[i % staffCodes.length].code, memberIndex: 0 });
    } else {
      // Counted separately from `i`, so every team gets dancers — sharing the
      // index with the staff test would leave one team with no clients at all
      // and make the scoped-edit fan-out a team that nobody is watching.
      const team = teamCodes[dancerSeat++ % teamCodes.length];
      const nth = dancersPerTeam.get(team.code) ?? 0;
      dancersPerTeam.set(team.code, nth + 1);
      specs.push({ id: i, code: team.code, memberIndex: nth });
    }
  }
  const clientsPerTeam = Math.round(
    [...dancersPerTeam.values()].reduce((a, n) => a + n, 0) / Math.max(1, dancersPerTeam.size)
  );

  /* ---------------------------- workers ---------------------------- */

  const workerCount = Math.max(1, Math.min(opts.workers, opts.clients));
  const workers = [];
  let nextMsgId = 1;
  const pending = new Map();

  for (let w = 0; w < workerCount; w++) {
    const child = fork(fileURLToPath(import.meta.url), ['--worker'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stderr.on('data', (d) => console.error(`[worker ${w}] ${d}`));
    child.on('message', (msg) => {
      if (msg?.ready) return;
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      msg.ok ? entry.resolve(msg.result) : entry.reject(new Error(msg.error));
    });
    workers.push(child);
  }

  const call = (child, type, payload) =>
    new Promise((resolve, reject) => {
      const id = nextMsgId++;
      pending.set(id, { resolve, reject });
      child.send({ id, type, payload });
    });
  const callAll = (type, payloadFor = () => ({})) =>
    Promise.all(workers.map((child, i) => call(child, type, payloadFor(i))));

  /* ------------------------------------------------------------------ *
   * Scenario runner
   *
   * A scenario is: clear every worker's buffer, do the admin action, then wait
   * for the clients to go quiet — no new observation anywhere for a second and
   * a half. Waiting on quiescence rather than a fixed sleep is what keeps the
   * tail honest; a fixed window would silently truncate the slowest refetch,
   * which is the number the whole exercise is for.
   * ------------------------------------------------------------------ */

  async function scenario(name, action, { settleMs = 1500, timeoutMs = 60_000 } = {}) {
    log(`\n▶ ${name}`);
    await callAll('reset');
    const t0 = Date.now();
    const cpuBefore = server ? await sampleProcess(server.pid) : null;

    const actionResult = await action();

    let lastCount = 0;
    let lastChange = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(250);
      const counts = await callAll('count');
      const total = counts.reduce((a, c) => a + c.count, 0);
      if (total !== lastCount) {
        lastCount = total;
        lastChange = Date.now();
      } else if (Date.now() - lastChange > settleMs) {
        break;
      }
    }
    const tEnd = Date.now();
    const cpuAfter = server ? await sampleProcess(server.pid) : null;

    const drained = await callAll('drain');
    const samples = drained.flatMap((d) => d.samples);

    const events = samples.filter((s) => s.kind === 'event');
    const refetches = samples.filter((s) => s.kind === 'refetch' || s.kind === 'disconnect-refetch');
    const errors = samples.filter((s) => s.error || (s.status && s.status >= 400));
    const windowProbes = probes.filter((p) => p.at >= t0 && p.at <= tEnd + 250);

    /**
     * Delivery is measured against the change that caused it, not against the
     * scenario's start — a burst dispatches twenty times, and timing the last
     * client's event from the first edit would report the burst's own duration
     * as latency.
     */
    const dispatches = (actionResult?.dispatchedAts ?? [actionResult?.dispatchedAt ?? t0])
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const deliveryFor = (at) => {
      let best = dispatches[0];
      for (const d of dispatches) {
        if (d <= at) best = d;
        else break;
      }
      return at - best;
    };

    const summary = {
      name,
      durationMs: tEnd - t0,
      action: actionResult,
      clientsWoken: new Set(events.map((e) => e.client)).size,
      events: events.length,
      // Time from the admin's request completing to the socket event landing.
      delivery: summarize(events.map((e) => deliveryFor(e.at))),
      refetch: summarize(refetches.map((r) => r.fetchMs)),
      /**
       * The number the event actually cares about: how long from the admin
       * pressing save until the last of the fleet is holding fresh data. A
       * refetch percentile hides the queue in front of it; this does not.
       */
      settleMs: refetches.length ? Math.max(...refetches.map((r) => r.at)) - dispatches[0] : null,
      health: summarize(windowProbes.map((p) => p.ms)),
      reconnects: samples.filter((s) => s.kind === 'reconnect').length,
      disconnects: samples.filter((s) => s.kind === 'disconnect').length,
      errors: errors.length,
      errorSample: errors.slice(0, 3),
      cpuSeconds:
        cpuBefore && cpuAfter ? Number((cpuAfter.cpuSeconds - cpuBefore.cpuSeconds).toFixed(2)) : null,
      rssMb: cpuAfter ? Number(cpuAfter.rssMb.toFixed(1)) : null,
    };
    results.scenarios[name] = summary;

    log(`    ${summary.clientsWoken} of ${opts.clients} clients woken, ${summary.events} events, ` +
        `${summary.errors} errors, ${summary.cpuSeconds ?? '—'} CPU-s, ${summary.rssMb ?? '—'} MB RSS`);
    if (summary.disconnects || summary.reconnects) {
      log(`    ${summary.disconnects} disconnects, ${summary.reconnects} reconnects`);
    }
    if (actionResult?.audiencePeople != null) {
      log(`    edit-log audience: ${actionResult.audiencePeople} people on the roster`);
    }
    if (actionResult?.adminMs != null) {
      log(`    admin request: ${ms(actionResult.adminMs)} (HTTP ${actionResult.status})`);
    }
    if (actionResult?.adminLatency?.n) log(row('admin PATCH /blocks/:id', actionResult.adminLatency));
    if (actionResult?.applyMs != null) {
      log(`    shift preview ${ms(actionResult.previewMs)}, apply ${ms(actionResult.applyMs)} ` +
          `moving ${actionResult.moved} blocks (HTTP ${actionResult.status})`);
    }
    if (summary.delivery.n) log(row('socket delivery', summary.delivery));
    if (summary.refetch.n) log(row('GET /api/schedule (refetch)', summary.refetch));
    if (summary.settleMs != null) {
      log(`    whole fleet holding fresh data ${ms(summary.settleMs)} after the change`);
    }
    if (summary.health.n) log(row('GET /api/health (probe)', summary.health));
    return summary;
  }

  /* ------------------- 1. sign-in and connect ------------------- */

  log(`\n▶ Ramp — ${opts.clients} clients across ${workerCount} workers at ~${opts.ramp}/s`);
  const perWorker = Math.ceil(specs.length / workerCount);
  const rampStarted = Date.now();
  const inits = await Promise.all(
    workers.map((child, i) =>
      call(child, 'init', {
        baseUrl: base,
        specs: specs.slice(i * perWorker, (i + 1) * perWorker),
        ramp: opts.ramp / workerCount,
      })
    )
  );
  const ramp = {
    durationMs: Date.now() - rampStarted,
    clientsPerTeam,
    signIn: summarize(inits.flatMap((r) => r.signIn)),
    identify: summarize(inits.flatMap((r) => r.identify)),
    connect: summarize(inits.flatMap((r) => r.connect)),
    failures: inits.flatMap((r) => r.failures),
    connected: inits.reduce((a, r) => a + r.connected, 0),
    blocksPerClient: Math.round(inits.reduce((a, r) => a + r.blocksSeen, 0) / opts.clients),
    health: summarize(probes.filter((p) => p.at >= rampStarted).map((p) => p.ms)),
  };
  results.ramp = ramp;
  log(`    ${ramp.connected} connected in ${(ramp.durationMs / 1000).toFixed(1)}s, ` +
      `${ramp.failures.length} failures, ~${ramp.blocksPerClient} blocks per schedule, ` +
      `~${clientsPerTeam} clients per team`);
  log(row('POST /api/session (sign-in)', ramp.signIn));
  log(row('POST /api/session/identify', ramp.identify));
  log(row('socket handshake', ramp.connect));
  log(row('GET /api/health (probe)', ramp.health));
  if (ramp.failures.length) log(`    first failure: ${ramp.failures[0]}`);

  // Everything below assumes a settled fleet.
  await sleep(1000);
  await callAll('reset');

  /* ------------------- 2. one team's edit ------------------- */

  const teamBlock = blocks.find((b) => b.appliesTo.type === 'team');
  await scenario('One team edit', async () => {
    const res = await asAdmin(`/api/admin/blocks/${teamBlock.id}`, {
      method: 'PATCH',
      body: { notes: `Load test ${Date.now()}`, expectedUpdatedAt: teamBlock.updatedAt },
    });
    const dispatchedAt = Date.now();
    const audience = (await asAdmin('/api/admin/log?limit=1')).json.entries?.[0]?.audience ?? null;
    return {
      dispatchedAt,
      adminMs: res.ms,
      status: res.status,
      target: teamBlock.appliesTo,
      audiencePeople: audience?.personIds?.length ?? null,
    };
  });

  /* ------------------- 3. a burst of edits ------------------- */

  await scenario('Burst — 20 edits back to back', async () => {
    // Read the versions now rather than reusing the list from before the first
    // scenario: item 14's guard would refuse a stale one, which is correct
    // behaviour and useless as load.
    const fresh = (await asAdmin('/api/admin/blocks')).json.blocks;
    const burstBlocks = fresh.filter((b) => b.appliesTo.type === 'team').slice(0, 20);
    const latencies = [];
    const dispatchedAts = [];
    const failures = [];
    for (const b of burstBlocks) {
      const res = await asAdmin(`/api/admin/blocks/${b.id}`, {
        method: 'PATCH',
        body: { notes: `Burst ${Date.now()}`, expectedUpdatedAt: b.updatedAt },
      });
      latencies.push(res.ms);
      dispatchedAts.push(Date.now());
      if (res.status !== 200) failures.push({ id: b.id, status: res.status, body: res.text.slice(0, 120) });
    }
    return { dispatchedAts, edits: latencies.length, failures, adminLatency: summarize(latencies) };
  });

  /* ------------------- 4. the bulk shift ------------------- */

  await scenario('Bulk shift — an afternoon moves 20 minutes', async () => {
    const current = (await asAdmin('/api/admin/blocks')).json.blocks;
    const afternoon = current.find((b) => b.startTime >= '15:00') || current[0];
    const preview = await asAdmin('/api/admin/blocks/shift/preview', {
      method: 'POST',
      body: { day: afternoon.day, fromTime: '15:00', minutes: 20 },
    });
    const moves = preview.json?.moves || [];
    if (!moves.length) return { skipped: 'nothing after 15:00 to shift', dispatchedAt: Date.now() };
    const applied = await asAdmin('/api/admin/blocks/shift', {
      method: 'POST',
      body: {
        minutes: 20,
        blocks: moves.map((m) => ({ id: m.id, expectedUpdatedAt: m.updatedAt })),
      },
    });
    return {
      dispatchedAt: Date.now(),
      day: afternoon.day,
      previewMs: preview.ms,
      applyMs: applied.ms,
      status: applied.status,
      moved: applied.json?.moved ?? 0,
      error: applied.status === 200 ? undefined : applied.text.slice(0, 200),
    };
  });

  /* ------------------- 5. the announcement ------------------- */

  await scenario('Announcement to everyone', async () => {
    const res = await asAdmin('/api/admin/blocks', {
      method: 'POST',
      body: {
        day: blocks[0].day,
        startTime: '12:00',
        endTime: '12:15',
        activity: 'Load test — evacuation drill',
        appliesToType: 'everyone',
        appliesToId: 'all',
        notes: 'Everyone leaves by the north doors.',
      },
    });
    return { dispatchedAt: Date.now(), adminMs: res.ms, status: res.status, blockId: res.json?.id };
  }, { timeoutMs: 120_000 });

  /* ------------------- 6. a roster edit ------------------- *
   * The other path that reaches all 600, and the more expensive one per socket:
   * a renamed team can change what any schedule renders, so `roster:updated`
   * goes out unscoped *and* re-derives every open socket's rooms server-side —
   * item 11's residual, measured here rather than assumed cheap.
   * ------------------------------------------------------------- */

  await scenario('Roster edit — a team renamed', async () => {
    const team = roster.teams[0];
    const res = await asAdmin(`/api/admin/teams/${team.id}`, {
      method: 'PATCH',
      body: { name: `${team.name.replace(/ \(load \d+\)$/, '')} (load ${Date.now() % 1000})` },
    });
    return { dispatchedAt: Date.now(), adminMs: res.ms, status: res.status };
  }, { timeoutMs: 120_000 });

  /* ------------------- 7. the mass reconnect ------------------- */

  await scenario('Mass reconnect — every socket dropped', async () => {
    const dispatchedAt = Date.now();
    const dropped = await callAll('reconnectAll');
    return { dispatchedAt, dropped: dropped.reduce((a, d) => a + d.dropped, 0) };
  }, { settleMs: 3000, timeoutMs: 120_000 });

  /* ---------------------------- teardown ---------------------------- */

  await callAll('shutdown');
  for (const child of workers) child.kill();
  probing = false;
  sampling = false;
  await probeLoop;
  if (server) await resourceLoop;

  results.probes = {
    all: summarize(probes.map((p) => p.ms)),
    failures: probes.filter((p) => p.status !== 200).length,
  };
  results.resource = {
    peakRssMb: resource.length ? Number(Math.max(...resource.map((r) => r.rssMb)).toFixed(1)) : null,
    cpuSecondsTotal: resource.length
      ? Number((resource[resource.length - 1].cpuSeconds - resource[0].cpuSeconds).toFixed(2))
      : null,
  };
  results.finishedAt = new Date().toISOString();

  log('\n▶ Whole run');
  log(row('GET /api/health (every probe)', results.probes.all));
  log(`    peak RSS ${results.resource.peakRssMb} MB, ${results.resource.cpuSecondsTotal} CPU-seconds total`);
  if (results.serverErrors?.length) {
    log(`    ⚠️ server wrote ${results.serverErrors.length} error/warning lines; first: ${results.serverErrors[0]}`);
  }

  if (server) {
    server.kill();
    await new Promise((resolve) => server.on('exit', resolve));
  }
  if (opts.json) {
    fs.writeFileSync(opts.json, JSON.stringify(results, null, 2));
    log(`\n  Results written to ${opts.json}`);
  }
  log('');
  return results;
}

if (process.argv.includes('--worker')) {
  await runWorker();
} else {
  await main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
