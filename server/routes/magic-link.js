import express from 'express';
import { redeemCode } from '../lib/viewer-auth.js';
import { subjectResolves } from './public.js';

/**
 * `/s/:code` — the path almost everyone actually takes. A captain forwards the
 * link, someone taps it, and they land on their schedule having typed nothing.
 *
 * Handled server-side rather than in the client on purpose:
 *
 *   - It works before any JavaScript runs, so a slow phone on venue wifi shows
 *     a schedule instead of a spinner.
 *   - The redirect means the code does not stay in the address bar, where it
 *     would ride along into screenshots and shared screens. An HTTP redirect
 *     also does not leave the code sitting in browser history the way a
 *     client-side rewrite does.
 *
 * Failures redirect to the code-entry screen with a reason rather than
 * rendering an error page, so there is exactly one place that explains what to
 * do next.
 */
export function magicLinkRouter() {
  const router = express.Router();

  router.get('/:code', (req, res) => {
    const result = redeemCode(req, res, req.params.code, { subjectResolves });
    if (!result.ok) {
      return res.redirect(302, `/?signin=${encodeURIComponent(result.reason)}`);
    }
    res.redirect(302, '/');
  });

  return router;
}
