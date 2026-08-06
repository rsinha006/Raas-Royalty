import express from 'express';
import {
  getBootstrap,
  getPersonalizedSchedule,
  listTeamMembers,
} from '../lib/queries.js';
import { scheduleUpdatedAt, db } from '../db.js';
import { eventTimeState, instantFromWallClockString } from '../lib/event-time.js';
import {
  requireViewer,
  resolveViewerSession,
  issueViewerSession,
  clearViewerSession,
  scheduleSessionFor,
  redeemCode,
  markUsed,
} from '../lib/viewer-auth.js';

/**
 * One message per failure reason. Distinct on purpose: "that code was replaced"
 * and "we don't recognise that code" send someone to two different
 * conversations at the check-in desk, and telling them apart costs nothing —
 * you have to already hold a code to learn that it was revoked.
 */
export const SIGN_IN_MESSAGE = {
  invalid: "We don't recognise that code.",
  revoked: 'That code has been replaced. Check for a newer link.',
  orphaned: 'That code points at something no longer on the roster.',
  rate: 'Too many incorrect codes. Try again shortly, or ask at the check-in desk.',
};

/** Does this code still point at something with a schedule? */
export function subjectResolves(record) {
  return Boolean(
    getPersonalizedSchedule(
      scheduleSessionFor({
        subjectType: record.subjectType,
        subjectId: record.subjectId,
        personId: null,
      })
    )
  );
}

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

  /**
   * What time the server thinks it is, and where.
   *
   * Unauthenticated on purpose: it carries no event data, and both the viewer
   * and the admin panel need it before anything else renders — the viewer to
   * correct its clock drift before the first now/next, the panel to show times
   * in venue terms. `?at=` resolves a rehearsal wall-clock (`?now=` in the
   * viewer URL) against the event zone.
   *
   * Note the schedule endpoint is deliberately not the one that does this: it
   * still reads no query parameters at all, which is the property item 6 left
   * behind and worth keeping unqualified.
   */
  router.get('/time', (req, res) => {
    const override = req.query.at ? instantFromWallClockString(req.query.at) : null;
    if (req.query.at && !override) {
      return res.status(400).json({ error: 'Expected at=YYYY-MM-DDTHH:MM' });
    }
    res.json({ ...eventTimeState(), ...(override ? { resolvedAt: override.toISOString() } : {}) });
  });

  /* ---------------------------- session ---------------------------- */

  /** Redeem an access code. The only way to obtain a viewer session. */
  router.post('/session', (req, res) => {
    const result = redeemCode(req, res, req.body?.code, { subjectResolves });
    if (!result.ok) {
      if (result.retryAfter) res.set('Retry-After', String(result.retryAfter));
      return res.status(result.status).json({
        error: SIGN_IN_MESSAGE[result.reason],
        reason: result.reason,
      });
    }
    res.json(sessionSummary({ ...result.record, personId: null }));
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
