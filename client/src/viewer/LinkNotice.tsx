import type { SignInReason } from '../types';

/**
 * "The link you just opened doesn't work — but you're still signed in."
 *
 * The case this exists for: someone taps a magic link that has been revoked or
 * replaced while already holding a good session on that device. The server
 * redirects with a reason, the old cookie is still valid, and without this the
 * schedule simply renders — so the app looks fine and nobody learns that the
 * link being passed around is dead. At a check-in desk that is the difference
 * between "we'll resend it" and twenty minutes of confusion.
 *
 * Dismissible, and not an error state: nothing is wrong with what is on screen.
 */

const LINK_MESSAGE: Partial<Record<SignInReason, string>> = {
  revoked: 'That link has been replaced by a newer one.',
  invalid: "That link's code isn't one we recognise.",
  orphaned: 'That link points at someone no longer on the roster.',
  rate: 'Too many code attempts from this device — that link was not checked.',
};

export default function LinkNotice({
  reason,
  subjectName,
  onDismiss,
}: {
  reason: SignInReason;
  subjectName?: string | null;
  onDismiss: () => void;
}) {
  const detail = LINK_MESSAGE[reason] ?? 'That link no longer works.';
  return (
    <div className="banner info" style={{ marginTop: 12 }} role="status">
      <span aria-hidden="true">🔗</span>
      <span>
        <strong>The link you just opened didn't sign you in.</strong> {detail} You're still
        signed in{subjectName ? ` as ${subjectName}` : ''}, and this schedule is up to date. If
        that link was meant for you, ask at the check-in desk for a new one.
        <br />
        <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={onDismiss}>
          Got it
        </button>
      </span>
    </div>
  );
}
