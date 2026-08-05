import { useState } from 'react';
import type { SignInReason } from '../types';

/**
 * The fallback path. Nearly everyone arrives through `/s/:code` and never sees
 * this screen — it exists for the second device, the forwarded-as-plain-text
 * link, and the person at the check-in desk reading a code off a printout.
 */

const CODE_LENGTH = 8;

/** Mirrors the server's alphabet: no 0/O, no 1/I/L, no U. */
const ALPHABET = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]*$/;

const MESSAGES: Record<SignInReason, { title: string; body: string }> = {
  invalid: {
    title: "That code doesn't work",
    body: "Check it against your link — codes are 8 characters, and there's no O, I, L or U in them.",
  },
  revoked: {
    title: 'That code has been replaced',
    body: 'A newer link was sent out. Look for the most recent one, or ask at the check-in desk.',
  },
  orphaned: {
    title: 'That code no longer points anywhere',
    body: 'The team or person it belonged to has been removed. Ask at the check-in desk.',
  },
  rate: {
    title: 'Too many tries',
    body: 'Wait a few minutes before trying again, or ask at the check-in desk for a fresh link.',
  },
  expired: {
    title: 'Your sign-in ran out',
    body: 'Open your link again to pick up where you left off, or type the code below.',
  },
  network: {
    title: "Can't reach the event server",
    body: "Check your connection and try again. If you've opened your schedule before, it will come back on its own.",
  },
};

export default function CodeEntry({
  eventName,
  reason,
  busy,
  onSubmit,
}: {
  eventName: string;
  reason: SignInReason | null;
  busy: boolean;
  onSubmit: (code: string) => void;
}) {
  const [code, setCode] = useState('');
  const [tooShort, setTooShort] = useState(false);

  const normalized = code.replace(/[\s-]/g, '');
  const ready = normalized.length === CODE_LENGTH;
  const message = reason ? MESSAGES[reason] : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) {
      setTooShort(true);
      return;
    }
    onSubmit(normalized);
  };

  return (
    <div className="landing">
      <div className="crown">♛</div>
      <h1>{eventName}</h1>
      <p className="landing-sub">
        Your schedule is private to you. Open the link you were sent, or enter your
        access code.
      </p>

      {message && (
        <div className="banner offline" style={{ marginTop: 4, marginBottom: 4 }} role="alert">
          <span aria-hidden="true">⚠️</span>
          <span>
            <strong>{message.title}</strong>
            <br />
            {message.body}
          </span>
        </div>
      )}

      <form className="stack" onSubmit={submit} style={{ width: '100%' }}>
        <label htmlFor="code" className="tiny faint">
          Access code
        </label>
        <input
          id="code"
          className="input code-input"
          value={code}
          onChange={(e) => {
            const next = e.target.value.toUpperCase();
            // Let people paste "K7M2-QX9P" or type it with a space.
            if (ALPHABET.test(next.replace(/[\s-]/g, ''))) {
              setCode(next);
              setTooShort(false);
            }
          }}
          placeholder="XXXXXXXX"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          maxLength={CODE_LENGTH + 3}
          aria-describedby="code-hint"
          disabled={busy}
        />
        <p id="code-hint" className="tiny faint" style={{ marginTop: -4 }}>
          {tooShort
            ? `That's ${normalized.length} of ${CODE_LENGTH} characters.`
            : `${CODE_LENGTH} characters, from your link or the check-in desk.`}
        </p>
        <button className="btn primary block-w" type="submit" disabled={busy || !ready}>
          {busy ? 'Checking…' : 'Show my schedule'}
        </button>
      </form>

      <p className="tiny faint" style={{ marginTop: 20 }}>
        Lost your link? Ask at the check-in desk — they can send you a new one.
      </p>
    </div>
  );
}
