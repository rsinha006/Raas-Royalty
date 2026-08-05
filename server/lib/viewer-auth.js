/**
 * Viewer sessions — turning an access code into a signed cookie, and turning
 * that cookie back into "which subject is this, and are they still allowed".
 *
 * The rule this file exists to enforce: **a viewer request never names its own
 * subject.** The client cannot ask for a team or person id; the server derives
 * the subject from the session and nothing else. Before this, any visitor could
 * read any participant's schedule and phone number by editing a query string.
 *
 * Two things are deliberately re-checked on every single request rather than
 * trusted from the cookie:
 *
 *   1. The authorizing code is still live. A signed cookie is self-contained,
 *      so without this check "revoke" would only stop *new* sign-ins and leave
 *      every already-issued session working — which is not what revoke means
 *      when a code has leaked mid-event.
 *   2. An identified person still belongs to the team whose code authorized
 *      them. The cookie is signed, so it cannot be forged, but it can go stale
 *      when someone moves teams.
 *
 * Both are single indexed lookups.
 */
import { db, nowIso } from '../db.js';
import { signPayload, verifyPayload } from './auth.js';
import { lookupCode, touchCodeUsed } from './access-codes.js';

const COOKIE = 'royalty_session';

/**
 * Seven days. Long enough to cover the event weekend from a link opened the
 * Monday before, short enough that a phone left in a taxi stops working. The
 * code itself does not expire — reopening the link re-establishes the session,
 * and revocation is the control that matters.
 */
const TTL_MS = 1000 * 60 * 60 * 24 * 7;

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ */

/**
 * Separate from the admin throttle: different budget, different consequence.
 * Ten wrong codes per quarter-hour per IP. Against a 30^8 keyspace this makes
 * guessing hopeless, and it is loose enough that a family at a check-in desk
 * fumbling the same code will not lock themselves out.
 */
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;
const failures = new Map();

function prune(now) {
  for (const [ip, rec] of failures) {
    if (now - rec.first > WINDOW_MS) failures.delete(ip);
  }
}

export function codeAttemptBlocked(ip) {
  const rec = failures.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return rec.count >= MAX_FAILURES;
}

export function recordCodeFailure(ip) {
  const now = Date.now();
  if (failures.size > 5000) prune(now);
  const rec = failures.get(ip);
  if (!rec || now - rec.first > WINDOW_MS) {
    failures.set(ip, { count: 1, first: now });
    return;
  }
  rec.count++;
}

export function clearCodeFailures(ip) {
  failures.delete(ip);
}

export function retryAfterSeconds(ip) {
  const rec = failures.get(ip);
  if (!rec) return 0;
  return Math.max(1, Math.ceil((rec.first + WINDOW_MS - Date.now()) / 1000));
}

/** Test seam. */
export function resetRateLimiter() {
  failures.clear();
}

/* ------------------------------------------------------------------ *
 * Cookie
 * ------------------------------------------------------------------ */

export function issueViewerSession(res, { code, subjectType, subjectId, personId = null }) {
  const token = signPayload({
    c: code,
    t: subjectType,
    i: subjectId,
    p: personId,
    exp: Date.now() + TTL_MS,
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: TTL_MS,
    secure: process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== '1',
  });
}

export function clearViewerSession(res) {
  res.clearCookie(COOKIE);
}

/**
 * The cookie, re-validated against current database state. Returns null for
 * anything that is not a live, coherent session — expired, tampered, revoked
 * code, deleted subject, or a person who no longer belongs to the team that
 * vouched for them.
 */
export function resolveViewerSession(req) {
  const payload = verifyPayload(req.cookies?.[COOKIE]);
  if (!payload || !payload.c || !payload.t || !payload.i) return null;

  const record = lookupCode(payload.c);
  if (!record || record.revokedAt) return null;
  if (record.subjectType !== payload.t || record.subjectId !== payload.i) return null;

  if (!subjectExists(payload.t, payload.i)) return null;

  if (payload.p) {
    // Only a team code can carry an identified person; anything else is a
    // cookie shape we never issue.
    if (payload.t !== 'team') return null;
    const person = db.prepare('SELECT id, team_id FROM people WHERE id = ?').get(payload.p);
    if (!person || person.team_id !== payload.i) return null;
  }

  return { code: payload.c, subjectType: payload.t, subjectId: payload.i, personId: payload.p || null };
}

function subjectExists(type, id) {
  const table = { team: 'teams', person: 'people', role: 'roles' }[type];
  if (!table) return false;
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
}

/**
 * The schedule session this viewer is entitled to — the only place a subject
 * id enters a viewer query. A team code before the identity step sees the
 * team-wide schedule; after it, that individual's, which is what makes
 * person-targeted blocks like airport pickups reachable at all.
 */
export function scheduleSessionFor(session) {
  if (session.subjectType === 'person') return { type: 'person', id: session.subjectId };
  if (session.subjectType === 'role') return { type: 'role', id: session.subjectId };
  return session.personId
    ? { type: 'person', id: session.personId }
    : { type: 'team', id: session.subjectId };
}

export function requireViewer(req, res, next) {
  const session = resolveViewerSession(req);
  if (!session) {
    clearViewerSession(res);
    return res.status(401).json({ error: 'Enter your access code to see your schedule.' });
  }
  req.viewer = session;
  next();
}

/** Best-effort usage stamp; never allowed to fail a request. */
export function markUsed(code) {
  try {
    touchCodeUsed(code);
  } catch {
    /* a usage timestamp is not worth a 500 */
  }
}

export { COOKIE as VIEWER_COOKIE, TTL_MS as VIEWER_TTL_MS, nowIso };
