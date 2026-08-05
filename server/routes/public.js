import express from 'express';
import {
  getBootstrap,
  getPersonalizedSchedule,
  listTeamMembers,
} from '../lib/queries.js';
import { scheduleUpdatedAt, db } from '../db.js';
import { lookupCode } from '../lib/access-codes.js';
import {
  requireViewer,
  resolveViewerSession,
  issueViewerSession,
  clearViewerSession,
  scheduleSessionFor,
  codeAttemptBlocked,
  recordCodeFailure,
  clearCodeFailures,
  retryAfterSeconds,
  markUsed,
} from '../lib/viewer-auth.js';

/**
 * The viewer API. Everything that returns schedule or roster data sits behind
 * `requireViewer`, and no endpoint accepts a subject id from the caller — the
 * subject comes from the session, which comes from a code.
 */
export function publicRouter() {
  const router = express.Router();

  /** Liveness only. No event data, so monitoring doesn't need a code. */
  router.get('/health', (req, res) => {
    res.json({ ok: true, updatedAt: scheduleUpdatedAt() });
  });

  /** Event name and nothing else. See getBootstrap. */
  router.get('/bootstrap', (req, res) => {
    res.json(getBootstrap());
  });

  /* ---------------------------- session ---------------------------- */

  /** Redeem an access code. The only way to obtain a viewer session. */
  router.post('/session', (req, res) => {
    const ip = req.ip || 'unknown';
    if (codeAttemptBlocked(ip)) {
      res.set('Retry-After', String(retryAfterSeconds(ip)));
      return res.status(429).json({
        error: 'Too many incorrect codes. Try again shortly, or ask at the check-in desk.',
      });
    }

    const record = lookupCode(req.body?.code);

    if (!record) {
      recordCodeFailure(ip);
      return res.status(401).json({ error: 'That code is not valid.', reason: 'invalid' });
    }
    if (record.revokedAt) {
      // A revoked code is a wrong code, but saying so is the difference between
      // a useful check-in desk conversation and a mystery. Knowing a code is
      // revoked requires already holding it.
      recordCodeFailure(ip);
      return res
        .status(401)
        .json({ error: 'That code has been replaced. Check for a newer link.', reason: 'revoked' });
    }

    const resolved = scheduleSessionFor({
      subjectType: record.subjectType,
      subjectId: record.subjectId,
      personId: null,
    });
    if (!getPersonalizedSchedule(resolved)) {
      recordCodeFailure(ip);
      return res
        .status(401)
        .json({ error: 'That code points at something no longer in the roster.', reason: 'orphaned' });
    }

    clearCodeFailures(ip);
    markUsed(record.code);
    issueViewerSession(res, {
      code: record.code,
      subjectType: record.subjectType,
      subjectId: record.subjectId,
    });
    res.json(sessionSummary({ ...record, personId: null }));
  });

  /** Who am I? Used on load to decide between the code screen and the schedule. */
  router.get('/session', (req, res) => {
    const session = resolveViewerSession(req);
    if (!session) return res.status(401).json({ error: 'No active session.' });
    res.json(sessionSummary(session));
  });

  router.delete('/session', (req, res) => {
    clearViewerSession(res);
    res.json({ ok: true });
  });

  /**
   * Names on the session's own team, for the identity step. Team codes only —
   * a staff code has nobody to choose between, and a role code must not become
   * a way to list a team.
   */
  router.get('/session/roster', requireViewer, (req, res) => {
    if (req.viewer.subjectType !== 'team') {
      return res.status(403).json({ error: 'This code is not a team code.' });
    }
    res.json({ people: listTeamMembers(req.viewer.subjectId) });
  });

  /**
   * "I'm this dancer." Upgrades a team session to a person session so
   * person-targeted blocks reach them. The chosen person must be on the team
   * the code authorized — checked here, and again on every later request.
   */
  router.post('/session/identify', requireViewer, (req, res) => {
    if (req.viewer.subjectType !== 'team') {
      return res.status(403).json({ error: 'This code is not a team code.' });
    }
    const personId = String(req.body?.personId || '');
    const person = db.prepare('SELECT id, team_id FROM people WHERE id = ?').get(personId);
    if (!person || person.team_id !== req.viewer.subjectId) {
      return res.status(403).json({ error: 'That person is not on this team.' });
    }

    issueViewerSession(res, {
      code: req.viewer.code,
      subjectType: req.viewer.subjectType,
      subjectId: req.viewer.subjectId,
      personId: person.id,
    });
    res.json(sessionSummary({ ...req.viewer, personId: person.id }));
  });

  /** Drop back to the team view — "I picked the wrong name". */
  router.delete('/session/identify', requireViewer, (req, res) => {
    if (req.viewer.subjectType !== 'team') {
      return res.status(403).json({ error: 'This code is not a team code.' });
    }
    issueViewerSession(res, {
      code: req.viewer.code,
      subjectType: req.viewer.subjectType,
      subjectId: req.viewer.subjectId,
      personId: null,
    });
    res.json(sessionSummary({ ...req.viewer, personId: null }));
  });

  /* ---------------------------- schedule ---------------------------- */

  /**
   * The personalized schedule.
   *
   * Note what is absent: this reads no query parameters. `type` and `id` used
   * to come from the client, which meant anyone could enumerate the roster and
   * then request any of it. The subject is now derived from the session alone,
   * so there is no parameter left to tamper with.
   */
  router.get('/schedule', requireViewer, (req, res) => {
    const payload = getPersonalizedSchedule(scheduleSessionFor(req.viewer));
    if (!payload) {
      // The subject was deleted between session checks.
      clearViewerSession(res);
      return res.status(404).json({ error: 'That selection is no longer in the roster.' });
    }
    markUsed(req.viewer.code);
    res.json({ ...payload, identified: Boolean(req.viewer.personId) });
  });

  return router;
}

function sessionSummary(session) {
  const resolved = getPersonalizedSchedule(
    scheduleSessionFor({
      subjectType: session.subjectType,
      subjectId: session.subjectId,
      personId: session.personId || null,
    })
  );
  return {
    subjectType: session.subjectType,
    identified: Boolean(session.personId),
    // A team code lands on the identity step; everything else goes straight
    // to a schedule.
    needsIdentity: session.subjectType === 'team' && !session.personId,
    subject: resolved?.subject ?? null,
  };
}
