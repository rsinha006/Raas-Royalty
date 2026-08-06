/**
 * Access-code management for the logistics panel — item 8.
 *
 * Everything here sits behind `requireAdmin` (mounted after it in admin.js).
 * That matters more than usual: these responses contain live bearer tokens for
 * every subject at the event, so an unauthenticated route here would be a
 * one-request dump of the whole roster's credentials. The CSV export carries
 * contact details alongside the codes, which is the point — it is the
 * mail-merge file — and also why it is admin-only and never linked publicly.
 *
 * The CLI (`npm run codes`) still exists and shares this module's library, so
 * the two cannot drift.
 */
import express from 'express';

import {
  codeForSubject,
  issueCode,
  listCodes,
  lookupCode,
  missingSubjects,
  regenerateAll,
  revokeCode,
  subjectExists,
} from '../lib/access-codes.js';
import { editorName } from '../lib/auth.js';

const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/**
 * Where the magic links point. Configured wins, because behind a proxy the
 * request's own host header is whatever the proxy passed along — and a CSV of
 * 280 links to the wrong hostname is discovered by the recipients, not by us.
 */
export function publicBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

export const linkFor = (base, code) => `${base}/s/${code}`;

const SUBJECT_TYPES = new Set(['team', 'person', 'role']);

/** One row's worth of everything the panel and the CSV both want. */
function decorate(code, base) {
  return { ...code, link: linkFor(base, code.code) };
}

export function adminCodesRouter() {
  const router = express.Router();

  const ctx = (req) => ({ editedBy: editorName(req), source: 'admin' });

  /* ---------------------------------------------------------------- *
   * Read
   * ---------------------------------------------------------------- */

  router.get('/', (req, res) => {
    const base = publicBaseUrl(req);
    const includeRevoked = req.query.revoked === 'true';
    const codes = listCodes({ includeRevoked }).map((c) => decorate(c, base));
    const live = codes.filter((c) => !c.revokedAt);
    const missing = missingSubjects();

    res.json({
      codes,
      missing,
      linkBase: base,
      summary: {
        live: live.length,
        revoked: codes.length - live.length,
        neverUsed: live.filter((c) => !c.lastUsedAt).length,
        orphaned: live.filter((c) => c.orphaned).length,
        missing: missing.length,
        teams: live.filter((c) => c.subjectType === 'team').length,
        people: live.filter((c) => c.subjectType === 'person').length,
        roles: live.filter((c) => c.subjectType === 'role').length,
      },
    });
  });

  /**
   * The mail-merge file: one row per live code, with the link already built.
   *
   * No email column, because no participant's own address exists anywhere in
   * this data model — `people.contact_id` is the coordinator they should call.
   * The merge therefore joins this file to whatever list logistics actually
   * mails from, on the subject name. Inventing a "send to" column out of the
   * contact cards would silently address a dozen private links to one inbox.
   *
   * Live codes only, and orphans excluded: a dead or unreachable link in front
   * of whoever runs the merge is worse than a missing row, which gets noticed.
   */
  router.get('/export.csv', (req, res) => {
    const base = publicBaseUrl(req);
    const type = req.query.type;
    const codes = listCodes()
      .filter((c) => !c.orphaned)
      .filter((c) => !type || c.subjectType === type);

    const header = ['Subject Type', 'Subject', 'Team', 'Role', 'Code', 'Link', 'Last Used'];
    const rows = codes.map((c) => [
      c.subjectType,
      c.subjectLabel,
      c.teamName,
      c.roleLabel,
      c.code,
      linkFor(base, c.code),
      c.lastUsedAt ?? 'never',
    ]);

    const body = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n');
    const stamp = new Date().toISOString().slice(0, 10);
    res
      .type('text/csv')
      .attachment(`royalty-access-links-${stamp}.csv`)
      .send(`${body}\n`);
  });

  /* ---------------------------------------------------------------- *
   * Write
   * ---------------------------------------------------------------- */

  /** Issue for a subject that has no live code — including role codes, which are never automatic. */
  router.post('/issue', (req, res) => {
    const { subjectType, subjectId } = req.body || {};
    if (!SUBJECT_TYPES.has(subjectType) || !subjectId) {
      return res.status(400).json({ error: 'subjectType and subjectId are required' });
    }
    if (!subjectExists(subjectType, subjectId)) {
      return res.status(404).json({ error: 'No such subject' });
    }
    const code = issueCode({ subjectType, subjectId }, ctx(req));
    res.json({ ok: true, code: decorate({ ...code, orphaned: false }, publicBaseUrl(req)) });
  });

  /** Issue for everything that should hold a code and doesn't. Never rotates an existing one. */
  router.post('/backfill', (req, res) => {
    const missing = missingSubjects();
    for (const s of missing) {
      issueCode({ subjectType: s.subjectType, subjectId: s.subjectId }, ctx(req));
    }
    res.json({ ok: true, created: missing.length });
  });

  /**
   * Rotate one code. The old one stops working immediately — which is the
   * point, and why the panel says so before you press it.
   */
  router.post('/:code/regenerate', (req, res) => {
    const found = lookupCode(req.params.code);
    if (!found) return res.status(404).json({ error: 'No such code' });
    if (found.revokedAt) {
      return res.status(409).json({ error: 'That code is revoked. Issue a new one instead.' });
    }
    if (!subjectExists(found.subjectType, found.subjectId)) {
      return res
        .status(409)
        .json({ error: 'That code points at something no longer on the roster. Revoke it instead.' });
    }
    const next = issueCode(
      { subjectType: found.subjectType, subjectId: found.subjectId, regenerate: true },
      ctx(req)
    );
    res.json({
      ok: true,
      previous: found.code,
      code: decorate({ ...next, orphaned: false }, publicBaseUrl(req)),
    });
  });

  router.post('/:code/revoke', (req, res) => {
    const found = lookupCode(req.params.code);
    if (!found) return res.status(404).json({ error: 'No such code' });
    const revoked = revokeCode(found.code, ctx(req));
    if (!revoked) return res.status(409).json({ error: 'That code was already revoked.' });
    res.json({ ok: true });
  });

  /**
   * Rotate everything. Guarded by a typed confirmation rather than a dialog the
   * browser can't distinguish from a misclick: it invalidates every link that
   * has gone out, which during the event means ~280 people locked out at once.
   */
  router.post('/regenerate-all', (req, res) => {
    const { confirm, subjectType = null } = req.body || {};
    if (confirm !== 'REGENERATE') {
      return res.status(400).json({ error: 'Type REGENERATE to confirm.' });
    }
    if (subjectType && !SUBJECT_TYPES.has(subjectType)) {
      return res.status(400).json({ error: 'Unknown subject type' });
    }
    const result = regenerateAll({ subjectType }, ctx(req));
    res.json({ ok: true, ...result });
  });

  /** A subject's current live code, for the "view as" and roster screens later on. */
  router.get('/for/:subjectType/:subjectId', (req, res) => {
    const { subjectType, subjectId } = req.params;
    if (!SUBJECT_TYPES.has(subjectType)) {
      return res.status(400).json({ error: 'Unknown subject type' });
    }
    const code = codeForSubject(subjectType, subjectId);
    if (!code) return res.status(404).json({ error: 'No live code for that subject' });
    res.json({ code: decorate({ ...code, orphaned: false }, publicBaseUrl(req)) });
  });

  return router;
}
